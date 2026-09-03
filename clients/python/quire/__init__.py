"""Quire experiment client: runs, metrics, logs, artifacts. Standard library only."""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Mapping, Optional
from urllib import error, request

__all__ = ["init", "Run", "QuireError"]
__version__ = "0.1.0"


class QuireError(RuntimeError):
    """Raised when the Quire server rejects a request."""


class _Client:
    def __init__(self, url: Optional[str] = None, api_key: Optional[str] = None, timeout: float = 30.0) -> None:
        self.url = (url or os.environ.get("QUIRE_URL", "")).rstrip("/")
        self.api_key = api_key or os.environ.get("QUIRE_API_KEY", "")
        self.timeout = timeout
        if not self.url:
            raise QuireError("Set QUIRE_URL (e.g. https://quire.ezragubbay.com) or pass url=")
        self._opener = request.build_opener()

    def _headers(self, content_type: Optional[str] = None) -> Dict[str, str]:
        h = {"user-agent": f"quire-client/{__version__}"}
        if self.api_key:
            h["authorization"] = f"Bearer {self.api_key}"
        if content_type:
            h["content-type"] = content_type
        return h

    def request(self, method: str, path: str, body: Optional[bytes] = None, content_type: Optional[str] = None) -> Any:
        req = request.Request(self.url + path, data=body, method=method, headers=self._headers(content_type))
        for attempt in range(3):
            try:
                with self._opener.open(req, timeout=self.timeout) as res:
                    raw = res.read()
                    return json.loads(raw) if raw else None
            except error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")
                if e.code >= 500 and attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise QuireError(f"{method} {path} -> {e.code}: {detail[:300]}") from None
            except error.URLError as e:
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise QuireError(f"{method} {path}: {e.reason}") from None

    def json(self, method: str, path: str, payload: Mapping[str, Any]) -> Any:
        return self.request(method, path, json.dumps(payload).encode("utf-8"), "application/json")

    def multipart(self, path: str, field: str, filename: str, data: bytes, content_type: str, extra: Mapping[str, str]) -> Any:
        boundary = "----quire" + uuid.uuid4().hex
        parts = []
        for k, v in extra.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n'.encode())
        parts.append(data)
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        return self.request("POST", path, b"".join(parts), f"multipart/form-data; boundary={boundary}")


class Run:
    """A run in progress. Create one with :func:`init`."""

    def __init__(self, client: _Client, project: str, run_id: str, name: str, url: str) -> None:
        self._client = client
        self.project = project
        self.id = run_id
        self.name = name
        self.url = url
        self._finished = False
        self._base = f"/api/projects/{project}/runs/{run_id}"

    def log(self, metrics: Mapping[str, float], step: Optional[int] = None) -> None:
        """Record metric values, optionally at a step."""
        payload: Dict[str, Any] = {"metrics": {k: float(v) for k, v in metrics.items()}}
        if step is not None:
            payload["step"] = int(step)
        self._client.json("POST", self._base + "/metrics", payload)

    def print(self, *parts: Any, level: str = "info") -> None:
        """Append a line to the run log (and echo it to stdout)."""
        message = " ".join(str(p) for p in parts)
        sys.stdout.write(message + "\n")
        self.lines([{"level": level, "message": message}])

    def lines(self, lines: Iterable[Mapping[str, Any]]) -> None:
        batch = [{"level": l.get("level", "info"), "message": str(l.get("message", "")), "ts": l.get("ts") or _now()} for l in lines]
        if batch:
            self._client.json("POST", self._base + "/logs", {"lines": batch})

    def artifact(self, path: str, name: Optional[str] = None) -> None:
        """Upload a file as an artifact of this run."""
        with open(path, "rb") as f:
            data = f.read()
        fname = name or os.path.basename(path)
        ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        self._client.multipart(self._base + "/artifacts", "file", fname, data, ctype, {"name": fname})

    def note(self, text: str) -> None:
        """Replace the run's notes field."""
        self._client.json("PATCH", self._base, {"notes": text})

    def finish(self, status: str = "done", metrics: Optional[Mapping[str, float]] = None, notes: Optional[str] = None) -> None:
        """Mark the run done (or failed), with optional final metrics."""
        if self._finished:
            return
        payload: Dict[str, Any] = {"status": status}
        if metrics:
            payload["metrics"] = {k: float(v) for k, v in metrics.items()}
        if notes is not None:
            payload["notes"] = notes
        self._client.json("POST", self._base + "/finish", payload)
        self._finished = True

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is not None:
            self.print(f"{exc_type.__name__}: {exc}", level="error")
            self.finish("failed")
        else:
            self.finish("done")


def init(
    project: str,
    experiment: str,
    name: Optional[str] = None,
    params: Optional[Mapping[str, Any]] = None,
    description: Optional[str] = None,
    url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Run:
    """Start a run. ``project`` is the project slug as it appears in the URL (/p/<slug>/...)."""
    client = _Client(url=url, api_key=api_key)
    payload: Dict[str, Any] = {"experiment": experiment, "params": dict(params or {})}
    if name:
        payload["name"] = name
    if description:
        payload["description"] = description
    res = client.json("POST", f"/api/projects/{project}/runs", payload)
    return Run(client, project, res["id"], res["name"], client.url + res["url"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
