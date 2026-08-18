ALTER TABLE ordenes DROP CONSTRAINT ordenes_estado_check;
ALTER TABLE ordenes ADD CONSTRAINT ordenes_estado_check CHECK (estado IN ('pendiente', 'pagada', 'fallida', 'cancelada'));