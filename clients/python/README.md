# quire-client

Report experiment runs to a [Quire](https://github.com/EzraGubbay/quire) project from anywhere your code runs. Standard library only.

```sh
pip install quire-client
export QUIRE_URL=https://quire.ezragubbay.com
export QUIRE_API_KEY=qk_...
```

```python
import quire

run = quire.init(project="sparse-attention-survey", experiment="routed-32k", name="lambda-0.1", params={"lambda": 0.1, "seq": 32768})
for step in range(100):
    run.log({"loss": 1.0 / (step + 1), "ppl": 12.4}, step=step)
run.print("epoch done")           # goes to the run log
run.artifact("results.json")       # uploads a file
run.finish(metrics={"final_ppl": 12.1})
```

`quire.init` creates the experiment on first use. Use `with quire.init(...) as run:` to mark the run failed automatically when an exception escapes. Metrics, logs, and artifacts show up live in the Experiments tab.
