from pricing import subtotal
from copy import deepcopy
assert subtotal(None) == 0
assert subtotal([]) == 0
assert subtotal([{"price": 0, "quantity": 9}]) == 0
assert subtotal([{"price": 5, "quantity": 0}, {"price": 3, "quantity": 2}]) == 6
assert subtotal([{"price": 5, "quantity": 3}]) == 15
values = [{"price": 2, "quantity": 0}, {"price": 3}]
original = deepcopy(values)
assert subtotal(values) == 3 and values == original
try:
    subtotal([{"price": 1, "quantity": -4}])
except ValueError:
    pass
else:
    raise AssertionError("negative quantity was not rejected")
print("7 independent boundary checks passed")
