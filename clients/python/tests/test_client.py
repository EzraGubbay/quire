import io
import json
from urllib import request

import quire


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_init_log_finish(monkeypatch, tmp_path):
    calls = []

    def fake_open(self, req, timeout=None):
        body = req.data.decode() if req.data and req.get_header("Content-type", "").startswith("application/json") else None
        calls.append((req.get_method(), req.full_url, json.loads(body) if body else req.get_header("Content-type")))
        if req.full_url.endswith("/runs"):
            return FakeResponse(json.dumps({"id": "r1", "name": "run-1", "url": "/p/demo/experiments/e1/runs/r1"}).encode())
        return FakeResponse(b'{"ok": true}')

    monkeypatch.setattr(request.OpenerDirector, "open", fake_open)
    monkeypatch.setenv("QUIRE_URL", "https://q.test")
    monkeypatch.setenv("QUIRE_API_KEY", "qk_x")

    art = tmp_path / "out.txt"
    art.write_text("hello")
    with quire.init("demo", "exp", params={"lr": 0.1}) as run:
        run.log({"loss": 0.5}, step=3)
        run.print("hi")
        run.artifact(str(art))
    assert run.url == "https://q.test/p/demo/experiments/e1/runs/r1"
    methods = [c[0] for c in calls]
    assert methods == ["POST", "POST", "POST", "POST", "POST"]
    assert calls[0][2] == {"experiment": "exp", "params": {"lr": 0.1}}
    assert calls[1][2] == {"metrics": {"loss": 0.5}, "step": 3}
    assert calls[2][2]["lines"][0]["message"] == "hi"
    assert calls[3][2].startswith("multipart/form-data")
    assert calls[4][2] == {"status": "done"}


def test_failure_marks_failed(monkeypatch):
    calls = []

    def fake_open(self, req, timeout=None):
        calls.append(json.loads(req.data.decode()) if req.data else None)
        if req.full_url.endswith("/runs"):
            return FakeResponse(json.dumps({"id": "r1", "name": "run-1", "url": "/x"}).encode())
        return FakeResponse(b"{}")

    monkeypatch.setattr(request.OpenerDirector, "open", fake_open)
    monkeypatch.setenv("QUIRE_URL", "https://q.test")
    try:
        with quire.init("demo", "exp"):
            raise ValueError("boom")
    except ValueError:
        pass
    assert calls[-1] == {"status": "failed"}
    assert calls[-2]["lines"][0]["level"] == "error"
