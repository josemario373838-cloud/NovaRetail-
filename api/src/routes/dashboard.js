const express = require("express");
const db = require("../config/db");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstDayOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /api/v1/dashboard
// ---------------------------------------------------------------------------

router.get(
  "/dashboard",
  authMiddleware(["gerente", "supervisor", "administrador"]),
  async (req, res) => {
    try {
      const {
        fecha_i = firstDayOfMonth(),
        fecha_f = today(),
        canal = "todos",
        categoria,
        top_n = 10,
      } = req.query;

      const topN = Math.min(Math.max(parseInt(top_n) || 10, 1), 100);

      // Build canal filter clause
      const canalFilter = canal === "todos" ? "TRUE" : "v.canal = $3";

      // Base params for most queries
      const baseParams =
        canal === "todos" ? [fecha_i, fecha_f] : [fecha_i, fecha_f, canal];

      // Ventas totales, productos distintos y transacciones
      const ventasQ = await db.query(
        `SELECT COALESCE(SUM(v.precio_unitario * v.cantidad), 0) AS total,
                COUNT(DISTINCT v.cod_producto) AS productos_distintos,
                COUNT(*) AS transacciones
         FROM ventas v
         WHERE v.fecha BETWEEN $1 AND $2
           AND ${canalFilter}`,
        baseParams
      );

      // Comparativa por canal
      const canalesQ = await db.query(
        `SELECT v.canal,
                SUM(v.precio_unitario * v.cantidad) AS total
         FROM ventas v
         WHERE v.fecha BETWEEN $1 AND $2
         GROUP BY v.canal
         ORDER BY total DESC`,
        [fecha_i, fecha_f]
      );

      const totalGeneral = parseFloat(ventasQ.rows[0].total) || 0;
      const comparativaCanales = canalesQ.rows.map((r) => ({
        canal: r.canal,
        total: parseFloat(r.total),
        porcentaje:
          totalGeneral > 0
            ? Math.round((parseFloat(r.total) / totalGeneral) * 10000) / 100
            : 0,
      }));

      // Top productos
      let topQuery = `
        SELECT v.cod_producto,
               COALESCE(p.nombre, v.cod_producto) AS nombre,
               SUM(v.cantidad)                    AS total_vendido,
               SUM(v.precio_unitario * v.cantidad) AS total_monto
        FROM ventas v
        LEFT JOIN productos p ON p.cod_producto = v.cod_producto
        WHERE v.fecha BETWEEN $1 AND $2
          AND ${canalFilter}`;

      const topParams = [...baseParams];

      if (categoria) {
        topParams.push(categoria);
        topQuery += ` AND p.categoria_id = (
          SELECT id FROM categorias WHERE codigo = $${topParams.length} LIMIT 1
        )`;
      }

      topQuery += ` GROUP BY v.cod_producto, p.nombre
                   ORDER BY total_vendido DESC
                   LIMIT $${topParams.length + 1}`;
      topParams.push(topN);

      const topQ = await db.query(topQuery, topParams);

      // Tendencia semanal
      const tendenciaQ = await db.query(
        `SELECT DATE_TRUNC('week', v.fecha)        AS semana,
                SUM(v.precio_unitario * v.cantidad) AS total_ventas
         FROM ventas v
         WHERE v.fecha BETWEEN $1 AND $2
           AND ${canalFilter}
         GROUP BY semana
         ORDER BY semana`,
        baseParams
      );

      // Alertas activas de stock crítico
      const alertasQ = await db.query(
        `SELECT COUNT(*) AS total
         FROM alertas
         WHERE revisada = false`
      );

      return res.status(200).json({
        ventas_totales: parseFloat(ventasQ.rows[0].total),
        productos_distintos: parseInt(ventasQ.rows[0].productos_distintos),
        transacciones: parseInt(ventasQ.rows[0].transacciones),
        comparativa_canales: comparativaCanales,
        top_productos: topQ.rows.map((r) => ({
          cod_producto: r.cod_producto,
          nombre: r.nombre,
          total_vendido: parseInt(r.total_vendido),
          total_monto: parseFloat(r.total_monto),
        })),
        tendencia_semanal: tendenciaQ.rows.map((r) => ({
          semana: r.semana,
          total_ventas: parseFloat(r.total_ventas),
        })),
        alertas_count: parseInt(alertasQ.rows[0].total),
      });
    } catch (err) {
      console.error("[GET /dashboard]", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

module.exports = router;
