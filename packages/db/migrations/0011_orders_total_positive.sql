-- F-2: Block zero or negative order totals at the DB layer.

ALTER TABLE orders
  ADD CONSTRAINT orders_total_positive CHECK (total > 0);