const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("../config/db");
const authMiddleware = require("../middleware/auth");
const auditoriaService = require("../services/auditoria");

const router = express.Router();

const DEFAULT_STOCK_MINIMO = 10;
const DEFAULT_UMBRAL_ROTACION = 50;

// ---------------------------------------------------------------------------
// Helper: severidad según stock
// ---------------------------------------------------------------------------
function calcSeveridad(stockActual, stockMinimo) {
  if (stockActual === 0) return "CRITICA";
  if (stockActual < stockMinimo * 0.5) return "ALTA";
  return "MEDIA";
}

// ---------------------------------------------------------------------------
// GET /api/v1/alertas
// ---------------------------------------------------------------------------

router.get(
  "/alertas",
  authMiddleware(["gerente", "supervisor", "administrador"]),
  async (req, res) => {
    try {
      const {
        tipo = "todos",
        categoria,
        page = 1,
        page_size = 20,
      } = req.query;

      const limit = Math.min(Math.max(parseInt(page_size) || 20, 1), 100);
      const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

      let alertas = [];

      // ── Stock crítico ────────────────────────────────────────────────────
      if (tipo === "todos" || tipo === "stock_critico") {
        let q = `
          SELECT a.id, a.tipo, a.cod_producto,
                 COALESCE(p.nombre, a.cod_producto) AS nombre,
                 a.stock_actual,
                 COALESCE(p.stock_minimo, $1)        AS stock_minimo,
                 a.severidad,
                 a.revisada, a.created_at
          FROM alertas a
          LEFT JOIN productos p ON p.cod_producto = a.cod_producto
          WHERE a.tipo = 'stock_critico'
            AND a.revisada = false`;

        const params = [DEFAULT_STOCK_MINIMO];

        if (categoria) {
          params.push(categoria);
          q += ` AND p.categoria_id = (
            SELECT id FROM categorias WHERE codigo = $${params.length} LIMIT 1
          )`;
        }

        q += ` ORDER BY a.stock_actual ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const { rows } = await db.query(q, params);
        alertas.push(...rows.map((r) => ({ ...r, tipo: "stock_critico" })));
      }

      // ── Baja rotación ────────────────────────────────────────────────────
      if (tipo === "todos" || tipo === "baja_rotacion") {
        const { rows } = await db.query(
          `SELECT a.id, a.tipo, a.cod_producto,
                  COALESCE(p.nombre, a.cod_producto) AS nombre,
                  a.stock_actual,
                  COALESCE(p.umbral_rotacion, $1)    AS umbral_rotacion,
                  a.severidad,
                  a.revisada, a.created_at
           FROM alertas a
           LEFT JOIN productos p ON p.cod_producto = a.cod_producto
           WHERE a.tipo = 'baja_rotacion'
             AND a.revisada = false
           ORDER BY a.created_at DESC
           LIMIT $2 OFFSET $3`,
          [DEFAULT_UMBRAL_ROTACION, limit, offset]
        );
        alertas.push(...rows.map((r) => ({ ...r, tipo: "baja_rotacion" })));
      }

      // ── Discrepancias ────────────────────────────────────────────────────
      if (tipo === "todos" || tipo === "discrepancia") {
        const { rows } = await db.query(
          `SELECT a.id, a.tipo, a.cod_producto,
                  COALESCE(p.nombre, a.cod_producto) AS nombre,
                  a.stock_actual,
                  a.delta,
                  a.severidad,
                  a.revisada, a.created_at
           FROM alertas a
           LEFT JOIN productos p ON p.cod_producto = a.cod_producto
           WHERE a.tipo = 'discrepancia'
             AND a.revisada = false
           ORDER BY ABS(a.delta) DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        alertas.push(...rows.map((r) => ({ ...r, tipo: "discrepancia" })));
      }

      return res.status(200).json({ alertas, total: alertas.length });
    } catch (err) {
      console.error("[GET /alertas]", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/alertas/recalcular  (calcula alertas desde inventario/ventas)
// ---------------------------------------------------------------------------

router.post(
  "/alertas/recalcular",
  authMiddleware(["administrador"]),
  async (req, res) => {
    try {
      const client = await db.connect();
      try {
        await client.query("BEGIN");

        // Limpiar alertas no revisadas anteriores
        await client.query("DELETE FROM alertas WHERE revisada = false");

        // ── Stock crítico: inventario más reciente por producto
        const stockRows = await client.query(`
          SELECT DISTINCT ON (i.cod_producto)
                 i.cod_producto,
                 i.stock_fisico,
                 COALESCE(p.stock_minimo, $1) AS stock_minimo
          FROM inventario i
          LEFT JOIN productos p ON p.cod_producto = i.cod_producto
          WHERE i.stock_fisico < COALESCE(p.stock_minimo, $1)
          ORDER BY i.cod_producto, i.fecha DESC, i.created_at DESC
        `, [DEFAULT_STOCK_MINIMO]);

        for (const r of stockRows.rows) {
          await client.query(
            `INSERT INTO alertas (id, tipo, cod_producto, stock_actual, stock_minimo, delta, severidad, revisada)
             VALUES ($1,'stock_critico',$2,$3,$4,$5,$6,false)`,
            [
              uuidv4(),
              r.cod_producto,
              r.stock_fisico,
              r.stock_minimo,
              r.stock_minimo - r.stock_fisico,
              calcSeveridad(r.stock_fisico, r.stock_minimo),
            ]
          );
        }

        // ── Discrepancias inventario
        const discRows = await client.query(`
          SELECT DISTINCT ON (i.cod_producto)
                 i.cod_producto,
                 i.stock_fisico,
                 i.stock_reportado,
                 ABS(i.stock_reportado - i.stock_fisico) AS delta
          FROM inventario i
          WHERE i.stock_reportado IS NOT NULL
            AND i.stock_fisico IS NOT NULL
            AND ABS(i.stock_reportado - i.stock_fisico) > 0
          ORDER BY i.cod_producto, i.fecha DESC
        `);

        for (const r of discRows.rows) {
          await client.query(
            `INSERT INTO alertas (id, tipo, cod_producto, stock_actual, stock_minimo, delta, severidad, revisada)
             VALUES ($1,'discrepancia',$2,$3,NULL,$4,'MEDIA',false)`,
            [uuidv4(), r.cod_producto, r.stock_fisico, r.delta]
          );
        }

        // ── Baja rotación (últimos 30 días)
        const rotRows = await client.query(`
          SELECT v.cod_producto,
                 COALESCE(SUM(v.cantidad), 0)       AS total_vendido,
                 COALESCE(p.umbral_rotacion, $1)    AS umbral
          FROM productos p
          LEFT JOIN ventas v
            ON v.cod_producto = p.cod_producto
           AND v.fecha >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY v.cod_producto, p.umbral_rotacion
          HAVING COALESCE(SUM(v.cantidad), 0) < COALESCE(p.umbral_rotacion, $1)
        `, [DEFAULT_UMBRAL_ROTACION]);

        for (const r of rotRows.rows) {
          await client.query(
            `INSERT INTO alertas (id, tipo, cod_producto, stock_actual, stock_minimo, delta, severidad, revisada)
             VALUES ($1,'baja_rotacion',$2,$3,NULL,$4,'MEDIA',false)`,
            [uuidv4(), r.cod_producto, parseInt(r.total_vendido), parseInt(r.umbral) - parseInt(r.total_vendido)]
          );
        }

        await client.query("COMMIT");

        const { rows } = await client.query(
          "SELECT COUNT(*) FROM alertas WHERE revisada = false"
        );
        return res.status(200).json({
          mensaje: "Alertas recalculadas correctamente",
          total_alertas: parseInt(rows[0].count),
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[POST /alertas/recalcular]", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/v1/alertas/:id/revisar
// ---------------------------------------------------------------------------

router.patch(
  "/alertas/:id/revisar",
  authMiddleware(["gerente", "supervisor", "administrador"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await db.query(
        `UPDATE alertas
         SET revisada = true, revisada_at = NOW(), revisada_by = $1
         WHERE id = $2
         RETURNING *`,
        [req.user.id, id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Alerta no encontrada" });
      }

      await auditoriaService.registrar(
        req.user.id,
        "ALERTA_REVISADA",
        req.ip,
        { alerta_id: id }
      );

      return res.status(200).json(rows[0]);
    } catch (err) {
      console.error("[PATCH /alertas/:id/revisar]", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/v1/productos/:id/umbral
// ---------------------------------------------------------------------------

router.patch(
  "/productos/:id/umbral",
  authMiddleware(["administrador"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { stock_minimo, umbral_rotacion } = req.body;

      if (
        (stock_minimo !== undefined && (!Number.isInteger(stock_minimo) || stock_minimo < 0)) ||
        (umbral_rotacion !== undefined && (!Number.isInteger(umbral_rotacion) || umbral_rotacion < 0))
      ) {
        return res
          .status(400)
          .json({ error: "stock_minimo y umbral_rotacion deben ser enteros >= 0" });
      }

      const { rows } = await db.query(
        `UPDATE productos
         SET stock_minimo     = COALESCE($1, stock_minimo),
             umbral_rotacion  = COALESCE($2, umbral_rotacion),
             updated_at       = NOW()
         WHERE id = $3
         RETURNING *`,
        [
          stock_minimo !== undefined ? stock_minimo : null,
          umbral_rotacion !== undefined ? umbral_rotacion : null,
          id,
        ]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Producto no encontrado" });
      }

      await auditoriaService.registrar(
        req.user.id,
        "UMBRAL_ACTUALIZADO",
        req.ip,
        { producto_id: id, stock_minimo, umbral_rotacion }
      );

      return res.status(200).json(rows[0]);
    } catch (err) {
      console.error("[PATCH /productos/:id/umbral]", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

module.exports = router;
