const express = require("express");
const db = require("../config/db");
const authMiddleware = require("../middleware/auth");
const auditoriaService = require("../services/auditoria");

const router = express.Router();

function firstDayOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /api/v1/reportes/pdf-data
// ---------------------------------------------------------------------------

router.get(
  "/reportes/pdf-data",
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
      const canalFilter = canal === "todos" ? "TRUE" : "v.canal = $3";
      const baseParams =
        canal === "todos" ? [fecha_i, fecha_f] : [fecha_i, fecha_f, canal];

      // KPIs principales
      const ventasQ = await db.query(
        `SELECT COALESCE(SUM(v.precio_unitario * v.cantidad), 0) AS total,
                COUNT(DISTINCT v.cod_producto)                   AS productos_distintos,
                COUNT(*)                                         AS transacciones
         FROM ventas v
         WHERE v.fecha BETWEEN $1 AND $2
           AND ${canalFilter}`,
        baseParams
      );

      // LOG DEBUG: ventasQ
      console.log('[DEBUG ventasQ.rows[0]]', ventasQ.rows[0]);

      // Comparativa canales
      const canalesQ = await db.query(
        `SELECT v.canal,
                SUM(v.precio_unitario * v.cantidad) AS total,
                COUNT(*) AS transacciones
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
        transacciones: parseInt(r.transacciones),
        porcentaje:
          totalGeneral > 0
            ? Math.round((parseFloat(r.total) / totalGeneral) * 10000) / 100
            : 0,
      }));

      // Top productos
      let topParams = [...baseParams];
      let topQuery = `
        SELECT v.cod_producto,
               COALESCE(p.nombre, v.cod_producto) AS nombre,
               SUM(v.cantidad)                    AS total_vendido,
               SUM(v.precio_unitario * v.cantidad) AS total_monto
        FROM ventas v
        LEFT JOIN productos p ON p.cod_producto = v.cod_producto
        WHERE v.fecha BETWEEN $1 AND $2
          AND ${canalFilter}`;

      if (categoria) {
        topParams.push(categoria);
        topQuery += ` AND p.categoria_id = (SELECT id FROM categorias WHERE codigo = $${topParams.length} LIMIT 1)`;
      }

      topParams.push(topN);
      topQuery += ` GROUP BY v.cod_producto, p.nombre
                   ORDER BY total_vendido DESC
                   LIMIT $${topParams.length}`;

      const topQ = await db.query(topQuery, topParams);

      // Tendencia semanal
      const tendenciaQ = await db.query(
        `SELECT DATE_TRUNC('week', v.fecha)        AS semana,
                SUM(v.precio_unitario * v.cantidad) AS total_ventas,
                COUNT(*)                            AS transacciones
         FROM ventas v
         WHERE v.fecha BETWEEN $1 AND $2
           AND ${canalFilter}
         GROUP BY semana
         ORDER BY semana`,
        baseParams
      );

      // Alertas activas
      const alertasQ = await db.query(
        "SELECT COUNT(*) AS total FROM alertas WHERE revisada = false"
      );

      // Última importación
      const importQ = await db.query(
        `SELECT created_at, tipo, estado, registros_validos
         FROM importaciones
         ORDER BY created_at DESC LIMIT 1`
      );

      // Registrar en auditoría
      await auditoriaService.registrar(
        req.user.id,
        "EXPORTAR_PDF",
        req.ip,
        { fecha_i, fecha_f, canal, categoria }
      );

      return res.status(200).json({
        generado_en: new Date().toISOString(),
        periodo: { fecha_i, fecha_f },
        kpis: {
          ventas_totales: parseFloat(ventasQ.rows[0].total),
          productos_distintos: parseInt(ventasQ.rows[0].productos_distintos),
          transacciones: parseInt(ventasQ.rows[0].transacciones),
          alertas_count: parseInt(alertasQ.rows[0].total),
        },
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
          transacciones: parseInt(r.transacciones),
        })),
        ultima_importacion: importQ.rows[0] || null,
      });
    } catch (err) {
      console.error("[GET /reportes/pdf-data]", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/auditoria
// ---------------------------------------------------------------------------

router.get("/auditoria", authMiddleware(["administrador"]), async (req, res) => {
  try {
    const {
      usuario_id,
      accion,
      fecha_i,
      fecha_f,
      page = 1,
      page_size = 50,
    } = req.query;

    const limit = Math.min(Math.max(parseInt(page_size) || 50, 1), 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    const conditions = [];
    const params = [];
    let i = 1;

    if (usuario_id) {
      conditions.push(`a.usuario_id = $${i++}`);
      params.push(usuario_id);
    }
    if (accion) {
      conditions.push(`a.accion = $${i++}`);
      params.push(accion.toUpperCase());
    }
    if (fecha_i) {
      conditions.push(`a.created_at >= $${i++}`);
      params.push(fecha_i);
    }
    if (fecha_f) {
      conditions.push(`a.created_at <= $${i++}::date + INTERVAL '1 day'`);
      params.push(fecha_f);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT a.id, a.accion, a.descripcion, a.ip_origen, a.metadata, a.created_at,
              u.nombre AS usuario_nombre, u.email AS usuario_email, u.rol AS usuario_rol
       FROM auditoria a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    );

    const countParams = params.slice(0, -2);
    const countResult = await db.query(
      `SELECT COUNT(*) FROM auditoria a ${where}`,
      countParams
    );

    return res.status(200).json({
      registros: rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      page_size: limit,
    });
  } catch (err) {
    console.error("[GET /auditoria]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
