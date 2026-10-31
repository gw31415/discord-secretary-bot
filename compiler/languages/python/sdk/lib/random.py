# random for the bot's MicroPython: the built-in module (random, randint,
# randrange, uniform, choice, getrandbits, seed) plus shuffle, sample, choices
# and gauss in pure Python. Seeded from WASI's random_get.
from urandom import *
import math as _math

_getrandbits = getrandbits


def getrandbits(k):
    """Any number of bits (the built-in one takes at most 32)."""
    n = 0
    shift = 0
    while k > 0:
        take = 32 if k > 32 else k
        n |= _getrandbits(take) << shift
        shift += take
        k -= take
    return n


def _below(n):
    if n <= 0:
        raise ValueError("empty range")
    k = n.bit_length() if hasattr(n, "bit_length") else len(bin(n)) - 2
    r = getrandbits(k)
    while r >= n:
        r = getrandbits(k)
    return r


def randrange(start, stop=None, step=1):
    if stop is None:
        start, stop = 0, start
    width = stop - start
    if step == 1:
        return start + _below(width)
    count = (width + step - 1) // step if step > 0 else (width + step + 1) // step
    return start + step * _below(count)


def randint(a, b):
    return randrange(a, b + 1)


def choice(seq):
    return seq[_below(len(seq))]


def shuffle(x):
    for i in range(len(x) - 1, 0, -1):
        j = _below(i + 1)
        x[i], x[j] = x[j], x[i]


def sample(population, k):
    pool = list(population)
    n = len(pool)
    if not 0 <= k <= n:
        raise ValueError("sample larger than population or is negative")
    for i in range(k):
        j = i + _below(n - i)
        pool[i], pool[j] = pool[j], pool[i]
    return pool[:k]


def choices(population, weights=None, *, cum_weights=None, k=1):
    n = len(population)
    if cum_weights is None:
        if weights is None:
            return [population[_below(n)] for _ in range(k)]
        cum_weights = []
        total = 0
        for w in weights:
            total += w
            cum_weights.append(total)
    total = cum_weights[-1]
    out = []
    for _ in range(k):
        r = random() * total
        lo, hi = 0, n - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if r < cum_weights[mid]:
                hi = mid
            else:
                lo = mid + 1
        out.append(population[lo])
    return out


def gauss(mu=0.0, sigma=1.0):
    u1 = 1.0 - random()
    u2 = random()
    return mu + sigma * _math.sqrt(-2.0 * _math.log(u1)) * _math.cos(2.0 * _math.pi * u2)


normalvariate = gauss
