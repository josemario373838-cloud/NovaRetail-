-- ============================================================
-- NovaRetail Analytics — Esquema PostgreSQL
-- CUT #1: Carga y Consolidación de Datos
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- Tabla: canales
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canales (
    id     SERIAL       PRIMARY KEY,
    codigo VARCHAR(30)  UNIQUE NOT NULL,
    nombre VARCHAR(100) NOT NULL
);

-- Datos semilla de canales
INSERT INTO canales (codigo, nombre) VALUES
    ('ONLINE',   'Canal Online'),
    ('TIENDA',   'Tienda Física'),
    ('MAYORISTA','Canal Mayorista'),
    ('B2B',      'Business to Business')
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------------
-- Tabla: productos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS productos (
    id     SERIAL       PRIMARY KEY,
    codigo VARCHAR(50)  UNIQUE NOT NULL,
    nombre VARCHAR(200)
);

-- ------------------------------------------------------------
-- Tabla: importaciones
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS importaciones (
    id                   UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    tipo                 VARCHAR(20)  NOT NULL CHECK (tipo IN ('ventas', 'inventario', 'pedidos')),
    estado               VARCHAR(10)  NOT NULL CHECK (estado IN ('EXITOSO', 'PARCIAL', 'FALLIDO')),
    total_registros      INT          NOT NULL DEFAULT 0,
    registros_validos    INT          NOT NULL DEFAULT 0,
    registros_rechazados INT          NOT NULL DEFAULT 0,
    archivo_hash         VARCHAR(64)  NOT NULL,
    url_log_errores      VARCHAR(500),
    created_at           TIMESTAMP    NOT NULL DEFAULT NOW(),
    created_by           VARCHAR(100) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_importaciones_hash      ON importaciones (archivo_hash);
CREATE INDEX IF NOT EXISTS idx_importaciones_created_at ON importaciones (created_at DESC);

-- ------------------------------------------------------------
-- Tabla: ventas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ventas (
    id               UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
    importacion_id   UUID           NOT NULL REFERENCES importaciones (id) ON DELETE CASCADE,
    fecha            DATE           NOT NULL,
    cod_producto     VARCHAR(50)    NOT NULL,
    canal            VARCHAR(30)    NOT NULL,
    cantidad         INT            NOT NULL CHECK (cantidad >= 0),
    precio_unitario  DECIMAL(12, 2) NOT NULL CHECK (precio_unitario >= 0),
    UNIQUE (importacion_id, fecha, cod_producto, canal)
);

CREATE INDEX IF NOT EXISTS idx_ventas_fecha        ON ventas (fecha);
CREATE INDEX IF NOT EXISTS idx_ventas_cod_producto ON ventas (cod_producto);

-- ------------------------------------------------------------
-- Tabla: inventario
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventario (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    importacion_id   UUID        NOT NULL REFERENCES importaciones (id) ON DELETE CASCADE,
    fecha            DATE        NOT NULL,
    cod_producto     VARCHAR(50) NOT NULL,
    stock_reportado  INT         NOT NULL CHECK (stock_reportado >= 0),
    stock_fisico     INT         CHECK (stock_fisico >= 0),
    UNIQUE (importacion_id, fecha, cod_producto)
);

CREATE INDEX IF NOT EXISTS idx_inventario_fecha        ON inventario (fecha);
CREATE INDEX IF NOT EXISTS idx_inventario_cod_producto ON inventario (cod_producto);
