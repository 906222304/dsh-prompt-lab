def subtotal(items):
    total = 0
    for item in items:
        quantity = item.get("quantity") or 1
        total += item["price"] * quantity
    return total
