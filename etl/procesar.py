#!/usr/bin/env python3
"""
ETL Service — NovaRetail Analytics
CUT #1: Carga y Consolidación de Datos

Uso:
    python procesar.py <ruta_archivo> <tipo> <importacion_id>

Tipos válidos:
    ventas | inventario | pedidos

Salida (stdout):
    JSON con {estado, total, validos, rechazados, errores, url_log_errores}
"""

from __future__ import annotations

import json
import logging
import os
import sys
import uuid
from pathlib import Path
from typing import List, Tuple

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("etl.procesar")

REQUIRED_COLUMNS: dict[str, List[str]] = {
    "ventas":     ["fecha", "cod_producto", "canal", "cantidad", "precio_unitario"],
    "inventario": ["fecha", "cod_producto", "stock_reportado"],
    "pedidos":    ["fecha", "cod_producto", "canal", "cantidad"],
}

DEDUP_KEYS: dict[str, List[str]] = {
    "ventas":     ["fecha", "cod_producto", "canal"],
    "inventario": ["fecha", "cod_producto"],
    "pedidos":    ["fecha", "cod_producto", "canal"],
}

# ---------------------------------------------------------------------------
# Helpers de base de datos
# ---------------------------------------------------------------------------


def _get_engine():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise EnvironmentError("DATABASE_URL no está definida en el entorno.")
    return create_engine(db_url, future=True)


# ---------------------------------------------------------------------------
# Lectura de archivo
# ---------------------------------------------------------------------------


def read_file(file_path: str) -> pd.DataFrame:
    ext = Path(file_path).suffix.lower()
    if ext == ".csv":
        return pd.read_csv(file_path, dtype=str)
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(file_path, dtype=str)
    raise ValueError(f"Formato de archivo no soportado: {ext}")


# ---------------------------------------------------------------------------
# Validación de columnas
# ---------------------------------------------------------------------------


def validate_columns(df: pd.DataFrame, tipo: str) -> List[str]:
    required = REQUIRED_COLUMNS.get(tipo, [])
    return [col for col in required if col not in df.columns]


# ---------------------------------------------------------------------------
# Limpieza: eliminación de duplicados
# ---------------------------------------------------------------------------


def clean_duplicates(df: pd.DataFrame, tipo: str) -> pd.DataFrame:
    keys = DEDUP_KEYS.get(tipo, [])
    existing_keys = [k for k in keys if k in df.columns]
    if existing_keys:
        before = len(df)
        df = df.drop_duplicates(subset=existing_keys, keep="first")
        removed = before - len(df)
        if removed:
            logger.info("Duplicados eliminados: %d", removed)
    return df.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Normalización de fechas
# ---------------------------------------------------------------------------


def normalize_dates(df: pd.DataFrame) -> Tuple[pd.DataFrame, List[dict]]:
    errors: List[dict] = []
    if "fecha" not in df.columns:
        return df, errors

    parsed = pd.to_datetime(df["fecha"], errors="coerce", format="mixed")
    invalid_mask = parsed.isna()

    if invalid_mask.any():
        bad_rows = df[invalid_mask].copy()
        bad_rows["error"] = "fecha inválida: " + bad_rows["fecha"].astype(str)
        errors.extend(_rows_to_dicts(bad_rows))
        logger.warning("Filas con fecha inválida: %d", invalid_mask.sum())

    df = df[~invalid_mask].copy()
    df["fecha"] = parsed[~invalid_mask]
    return df.reset_index(drop=True), errors


# ---------------------------------------------------------------------------
# Normalización de montos / cantidades
# ---------------------------------------------------------------------------

_NUMERIC_COLS = {
    "ventas":     ["cantidad", "precio_unitario"],
    "inventario": ["stock_reportado", "stock_fisico"],
    "pedidos":    ["cantidad"],
}


def normalize_amounts(df: pd.DataFrame, tipo: str) -> Tuple[pd.DataFrame, List[dict]]:
    errors: List[dict] = []
    target_cols = [c for c in _NUMERIC_COLS.get(tipo, []) if c in df.columns]

    for col in target_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")
        invalid_mask = df[col].isna()
        if invalid_mask.any():
            bad_rows = df[invalid_mask].copy()
            bad_rows["error"] = f"valor no numérico en columna '{col}'"
            errors.extend(_rows_to_dicts(bad_rows))
            logger.warning("Filas con '%s' inválido: %d", col, invalid_mask.sum())
            df = df[~invalid_mask].copy()

    # Estandarizar tipos
    if tipo == "ventas":
        if "cantidad" in df.columns:
            df["cantidad"] = df["cantidad"].astype(int)
        if "precio_unitario" in df.columns:
            df["precio_unitario"] = df["precio_unitario"].round(2)

    if tipo == "inventario":
        if "stock_reportado" in df.columns:
            df["stock_reportado"] = df["stock_reportado"].astype(int)
        if "stock_fisico" in df.columns:
            df["stock_fisico"] = pd.to_numeric(df["stock_fisico"], errors="coerce")

    # Normalizar canal (strip + upper)
    if "canal" in df.columns:
        df["canal"] = df["canal"].str.strip().str.upper()

    # Normalizar cod_producto (strip)
    if "cod_producto" in df.columns:
        df["cod_producto"] = df["cod_producto"].str.strip()

    return df.reset_index(drop=True), errors


# ---------------------------------------------------------------------------
# Carga a PostgreSQL
# ---------------------------------------------------------------------------


def load_to_db(df: pd.DataFrame, tipo: str, importacion_id: str, engine) -> int:
    if tipo == "ventas":
        return _load_ventas(df, importacion_id, engine)
    if tipo == "inventario":
        return _load_inventario(df, importacion_id, engine)
    # pedidos: extensible en futuros CUTs
    logger.warning("Tipo '%s' aún no persiste en BD.", tipo)
    return len(df)


def _load_ventas(df: pd.DataFrame, importacion_id: str, engine) -> int:
    cols = ["fecha", "cod_producto", "canal", "cantidad", "precio_unitario"]
    df = df[cols].copy()
    df["id"] = [str(uuid.uuid4()) for _ in range(len(df))]
    df["importacion_id"] = importacion_id
    df["fecha"] = df["fecha"].dt.date

    sql = text("""
        INSERT INTO ventas
            (id, importacion_id, fecha, cod_producto, canal, cantidad, precio_unitario)
        VALUES
            (:id, :importacion_id, :fecha, :cod_producto, :canal, :cantidad, :precio_unitario)
        ON CONFLICT (importacion_id, fecha, cod_producto, canal) DO NOTHING
    """)

    inserted = 0
    with engine.begin() as conn:
        for row in df.to_dict("records"):
            result = conn.execute(sql, row)
            inserted += result.rowcount
    return inserted


def _load_inventario(df: pd.DataFrame, importacion_id: str, engine) -> int:
    cols = ["fecha", "cod_producto", "stock_reportado"]
    if "stock_fisico" in df.columns:
        cols.append("stock_fisico")

    df = df[cols].copy()
    df["id"] = [str(uuid.uuid4()) for _ in range(len(df))]
    df["importacion_id"] = importacion_id
    df["fecha"] = df["fecha"].dt.date
    if "stock_fisico" not in df.columns:
        df["stock_fisico"] = None

    sql = text("""
        INSERT INTO inventario
            (id, importacion_id, fecha, cod_producto, stock_reportado, stock_fisico)
        VALUES
            (:id, :importacion_id, :fecha, :cod_producto, :stock_reportado, :stock_fisico)
        ON CONFLICT (importacion_id, fecha, cod_producto) DO NOTHING
    """)

    inserted = 0
    with engine.begin() as conn:
        for row in df.to_dict("records"):
            result = conn.execute(sql, row)
            inserted += result.rowcount
    return inserted


# ---------------------------------------------------------------------------
# Log de errores
# ---------------------------------------------------------------------------


def write_error_log(errors: List[dict], importacion_id: str) -> str | None:
    if not errors:
        return None
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    log_path = log_dir / f"{importacion_id}_errores.json"
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(errors, f, ensure_ascii=False, indent=2, default=_json_default)
    logger.info("Log de errores escrito: %s", log_path)
    return str(log_path)


def _json_default(obj):
    if isinstance(obj, float) and np.isnan(obj):
        return None
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    return str(obj)


def _rows_to_dicts(df: pd.DataFrame) -> List[dict]:
    return [
        {k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in row.items()}
        for row in df.to_dict("records")
    ]


# ---------------------------------------------------------------------------
# Función principal
# ---------------------------------------------------------------------------


def procesar(file_path: str, tipo: str, importacion_id: str) -> dict:
    resultado = {
        "estado": "FALLIDO",
        "total": 0,
        "validos": 0,
        "rechazados": 0,
        "errores": [],
        "url_log_errores": None,
    }

    try:
        # 1. Leer archivo
        df = read_file(file_path)
        if df.empty:
            resultado["errores"] = ["El archivo no contiene datos"]
            return resultado

        # 2. Validar columnas requeridas
        missing = validate_columns(df, tipo)
        if missing:
            resultado["errores"] = [f"Columnas faltantes: {missing}"]
            return resultado

        # 3. Eliminar duplicados
        df = clean_duplicates(df, tipo)
        total_after_dedup = len(df)

        # 4. Normalizar fechas
        df, date_errors = normalize_dates(df)

        # 5. Normalizar montos / cantidades
        df, amount_errors = normalize_amounts(df, tipo)

        all_errors = date_errors + amount_errors
        rechazados = len(all_errors)
        validos_esperados = total_after_dedup - rechazados

        # 6. Cargar a BD
        engine = _get_engine()
        validos = load_to_db(df, tipo, importacion_id, engine)

        # 7. Escribir log de errores
        url_log = write_error_log(all_errors, importacion_id)

        resultado["total"] = total_after_dedup
        resultado["validos"] = validos
        resultado["rechazados"] = rechazados
        resultado["url_log_errores"] = url_log

        if validos == 0:
            resultado["estado"] = "FALLIDO"
        elif rechazados > 0:
            resultado["estado"] = "PARCIAL"
        else:
            resultado["estado"] = "EXITOSO"

        logger.info(
            "ETL completado | tipo=%s | total=%d | validos=%d | rechazados=%d | estado=%s",
            tipo,
            total_after_dedup,
            validos,
            rechazados,
            resultado["estado"],
        )

    except EnvironmentError as exc:
        logger.error("Error de configuración: %s", exc)
        resultado["errores"] = [str(exc)]
    except Exception as exc:
        logger.exception("Error inesperado en ETL: %s", exc)
        resultado["errores"] = [str(exc)]

    return resultado


# ---------------------------------------------------------------------------
# Punto de entrada
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(
            json.dumps({"error": "Uso: procesar.py <ruta_archivo> <tipo> <importacion_id>"})
        )
        sys.exit(1)

    _file_path = sys.argv[1]
    _tipo = sys.argv[2]
    _importacion_id = sys.argv[3]

    if _tipo not in REQUIRED_COLUMNS:
        print(json.dumps({"error": f"Tipo inválido: {_tipo}. Valores: {list(REQUIRED_COLUMNS)}"}))
        sys.exit(1)

    result = procesar(_file_path, _tipo, _importacion_id)
    print(json.dumps(result, default=_json_default))
