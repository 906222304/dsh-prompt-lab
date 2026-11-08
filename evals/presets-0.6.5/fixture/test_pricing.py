import unittest
from copy import deepcopy
from pricing import subtotal
class SubtotalTests(unittest.TestCase):
    def test_empty(self): self.assertEqual(subtotal([]), 0)
    def test_none(self): self.assertEqual(subtotal(None), 0)
    def test_default_quantity(self): self.assertEqual(subtotal([{"price": 7}]), 7)
    def test_zero_quantity(self): self.assertEqual(subtotal([{"price": 7, "quantity": 0}]), 0)
    def test_negative_quantity(self):
        with self.assertRaises(ValueError): subtotal([{"price": 7, "quantity": -1}])
    def test_no_mutation(self):
        values = [{"price": 7, "quantity": 2}, {"price": 3}]
        original = deepcopy(values)
        self.assertEqual(subtotal(values), 17)
        self.assertEqual(values, original)
if __name__ == "__main__": unittest.main()
