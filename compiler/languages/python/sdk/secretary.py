# The SDK: reads the input, calls the host (secretary.call) and writes the result.
# See docs/wasm.md for what the host functions take and return.
import json
import _secretary


class HostError(Exception):
    """The host refused a call: the message says why."""


_input = None


def input():
    """The JSON on stdin (guild, actor, eventName, event, batch, params, state) as a dict."""
    global _input
    if _input is None:
        text = _secretary.read_stdin()
        _input = json.loads(text) if text else {}
    return _input


def call(request):
    """Sends {"fn": ...} to the host and returns its value. Raises HostError on an error."""
    answer = json.loads(_secretary.call(json.dumps(request)))
    error = answer.get("error")
    if isinstance(error, str):
        raise HostError(error)
    return answer.get("value")


def get(route, query=None):
    """Discord REST GET (what the rule's author can read). query is a dict such as {"limit": 1}."""
    request = {"fn": "get", "route": route}
    if query:
        request["query"] = query
    return call(request)


def output(result):
    """Writes { steps, state?, reply? } to stdout. Call it once, at the end."""
    _secretary.write_stdout(json.dumps(result))
