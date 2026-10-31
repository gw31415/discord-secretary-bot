# collections.defaultdict for the bot's MicroPython: a dict subclass (unlike
# micropython-lib's wrapper), so dict(), json.dumps and isinstance(d, dict) work.
# No __repr__: json.dumps would use it; it prints like a plain dict.


class defaultdict(dict):
    def __init__(self, default_factory=None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.default_factory = default_factory

    def __getitem__(self, key):
        try:
            return super().__getitem__(key)
        except KeyError:
            return self.__missing__(key)

    def __missing__(self, key):
        if self.default_factory is None:
            raise KeyError(key)
        value = self.default_factory()
        self[key] = value
        return value

