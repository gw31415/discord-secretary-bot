# Run by prewarm.sh on the MicroPython source: small fixes for the bot.
# Each patch must apply exactly once, so a new MicroPython version that moved
# the code fails the setup instead of building without the fix.
# Usage: python3 patches.py <micropython>
import os
import sys

PATCHES = [
    (
        # A string grows by what it needs plus 16 bytes, so building a long one
        # piece by piece (json.dumps of a large value) copies it over and over.
        # Grow by half again instead.
        "py/vstr.c",
        "size_t new_alloc = ROUND_ALLOC((vstr->len + size) + 16);",
        "size_t new_alloc = ROUND_ALLOC((vstr->len + size) + 16 + vstr->len / 2);",
    ),
    (
        # dict(d) and x.update(d) treat an instance of a dict subclass (such as
        # collections.defaultdict) as a dict, not as a sequence of pairs.
        "py/objdict.c",
        """    if (n_args == 2) {
        // given a positional argument

        if (mp_obj_is_dict_or_ordereddict(args[1])) {""",
        """    if (n_args == 2) {
        // given a positional argument

        mp_obj_t native = mp_obj_cast_to_native_base(args[1], MP_OBJ_FROM_PTR(&mp_type_dict));
        if (native != MP_OBJ_NULL && native != args[1] && native != args[0]) {
            mp_obj_t pair[2] = {args[0], native};
            return dict_update(2, pair, kwargs);
        }

        if (mp_obj_is_dict_or_ordereddict(args[1])) {""",
    ),
]


def main():
    top = sys.argv[1]
    for path, old, new in PATCHES:
        full = os.path.join(top, path)
        with open(full) as f:
            text = f.read()
        if text.count(old) != 1:
            sys.exit("patch does not apply: %s" % path)
        with open(full, "w") as f:
            f.write(text.replace(old, new))
    print("patches: %d applied" % len(PATCHES))


main()
