-- Locais do cliente verificados (confirmados pelo cliente ou corrigidos pelo operador).
-- O local verificado mais recente é o usado nas próximas entregas.
ALTER TABLE customer_places ADD COLUMN verified_at timestamptz;
ALTER TABLE customer_places ADD COLUMN verified_by text CHECK (verified_by IN ('cliente', 'operador'));
UPDATE customer_places SET verified_at = last_used_at, verified_by = 'cliente' WHERE confirmed_by_customer;
ALTER TABLE customer_places ADD CONSTRAINT customer_places_verified_chk CHECK ((verified_at IS NULL) = (verified_by IS NULL));

-- revisões de "entregue longe do pino" são consultadas por entrega
CREATE INDEX events_pin_review_idx ON events (delivery_id, at DESC) WHERE type = 'pin.reviewed';
