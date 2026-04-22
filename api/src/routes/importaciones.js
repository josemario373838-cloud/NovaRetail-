const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const authMiddleware = require("../middleware/auth");
const db = require("../config/db");

const router = express.Router();

// ---------------------------------------------------------------------------
// Configuración de Multer (memoria, límite 50 MB)
// ---------------------------------------------------------------------------

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_EXTENSIONS = [".csv", ".xlsx", ".xls"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(null, true);
    }
    cb(new Error("FORMATO_INVALIDO"));
  },
});

const VALID_TIPOS = ["ventas", "inventario", "pedidos"];

// ---------------------------------------------------------------------------
// Resolución del binario Python (usa el venv del proyecto)
// ---------------------------------------------------------------------------

function getPythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const projectRoot = path.resolve(__dirname, "../../../");
  if (process.platform === "win32") {
    return path.join(projectRoot, "etl", "venv", "Scripts", "python.exe");
  }
  return path.join(projectRoot, "etl", "venv", "bin", "python3");
}

// ---------------------------------------------------------------------------
// POST /api/v1/importaciones/cargar
// ---------------------------------------------------------------------------

router.post(
  "/importaciones/cargar",
  authMiddleware(["administrador"]),
  (req, res, next) => {
    upload.single("archivo")(req, res, (err) => {
      if (!err) return next();

      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Archivo mayor a 50 MB no permitido" });
      }
      if (err.message === "FORMATO_INVALIDO") {
        return res.status(400).json({
          error: "Formato de archivo no soportado. Use CSV (.csv) o Excel (.xlsx, .xls).",
        });
      }
      return next(err);
    });
  },
  async (req, res) => {
    let tmpPath = null;

    try {
      // Validar presencia de archivo
      if (!req.file) {
        return res.status(400).json({ error: "No se proporcionó archivo" });
      }

      const { tipo, fecha_referencia } = req.body;

      // Validar tipo
      if (!tipo || !VALID_TIPOS.includes(tipo)) {
        return res.status(400).json({
          error: `tipo inválido. Valores permitidos: ${VALID_TIPOS.join(", ")}`,
        });
      }

      const fileBuffer = req.file.buffer;

      // Validar que no esté vacío
      if (fileBuffer.length === 0) {
        return res.status(400).json({ error: "El archivo no contiene datos" });
      }

      // Calcular hash MD5
      const hash = crypto.createHash("md5").update(fileBuffer).digest("hex");

      // Detectar importación duplicada SOLO si fue EXITOSO o PARCIAL
      const dupCheck = await db.query(
        "SELECT id, estado FROM importaciones WHERE archivo_hash = $1 AND estado IN ('EXITOSO', 'PARCIAL')",
        [hash]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({
          error: "El archivo ya fue importado anteriormente.",
          importacion_id: dupCheck.rows[0].id,
        });
      }

      // Guardar archivo temporal
      const ext = path.extname(req.file.originalname).toLowerCase();
      tmpPath = path.join(os.tmpdir(), `${uuidv4()}${ext}`);
      fs.writeFileSync(tmpPath, fileBuffer);


      const importacionId = uuidv4();
      const pythonBin = getPythonBin();
      const etlScript = path.resolve(__dirname, "../../../etl/procesar.py");

      // Crear registro en importaciones ANTES de ejecutar el ETL
      await db.query(
        `INSERT INTO importaciones
           (id, tipo, estado, total_registros, registros_validos, registros_rechazados, archivo_hash, created_by)
         VALUES ($1, $2, $3, 0, 0, 0, $4, $5)`,
        [importacionId, tipo, 'EN_PROCESO', hash, req.user.id]
      );

      // Invocar ETL Service
      const etlResult = spawnSync(pythonBin, [etlScript, tmpPath, tipo, importacionId], {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      // ETL no disponible
      if (etlResult.status === null || etlResult.error) {
        await db.query(
          `UPDATE importaciones SET estado = 'FALLIDO' WHERE id = $1`,
          [importacionId]
        );
        return res.status(503).json({
          error: "ETL Service no disponible",
          importacion_id: importacionId,
        });
      }

      // Parsear respuesta del ETL
      let resultado;
      try {
        resultado = JSON.parse(etlResult.stdout.toString());
      } catch {
        await db.query(
          `UPDATE importaciones SET estado = 'FALLIDO' WHERE id = $1`,
          [importacionId]
        );
        return res.status(500).json({ error: "Respuesta inválida del ETL Service" });
      }

      // El ETL detectó error de validación (columnas faltantes, archivo vacío, etc.)
      if (resultado.errores && resultado.errores.length > 0 && resultado.estado === "FALLIDO") {
        await db.query(
          `UPDATE importaciones SET estado = 'FALLIDO' WHERE id = $1`,
          [importacionId]
        );
        return res.status(400).json({ error: resultado.errores[0] });
      }

      // Actualizar importación en BD con los resultados
      await db.query(
        `UPDATE importaciones SET
           estado = $2,
           total_registros = $3,
           registros_validos = $4,
           registros_rechazados = $5,
           url_log_errores = $6
         WHERE id = $1`,
        [
          importacionId,
          resultado.estado,
          resultado.total,
          resultado.validos,
          resultado.rechazados,
          resultado.url_log_errores || null
        ]
      );

      return res.status(200).json({
        importacion_id: importacionId,
        estado: resultado.estado,
        total_registros: resultado.total,
        registros_validos: resultado.validos,
        registros_rechazados: resultado.rechazados,
        url_log_errores: resultado.url_log_errores
          ? `/api/v1/importaciones/${importacionId}/log-errores`
          : null,
      });
    } catch (err) {
      console.error("[/importaciones/cargar]", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    } finally {
      // Limpiar archivo temporal
      if (tmpPath && fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/importaciones
// ---------------------------------------------------------------------------

router.get("/importaciones", authMiddleware(["administrador"]), async (_req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM importaciones ORDER BY created_at DESC LIMIT 100"
    );
    return res.status(200).json(rows);
  } catch (err) {
    console.error("[/importaciones]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/importaciones/:id
// ---------------------------------------------------------------------------

router.get("/importaciones/:id", authMiddleware(["administrador"]), async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM importaciones WHERE id = $1",
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Importación no encontrada" });
    }
    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error("[/importaciones/:id]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/importaciones/:id/log-errores
// ---------------------------------------------------------------------------

router.get("/importaciones/:id/log-errores", authMiddleware(["administrador"]), async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT url_log_errores FROM importaciones WHERE id = $1",
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Importación no encontrada" });
    }
    const logPath = rows[0].url_log_errores;
    if (!logPath || !fs.existsSync(logPath)) {
      return res.status(404).json({ error: "Log de errores no disponible para esta importación" });
    }
    return res.download(logPath, path.basename(logPath));
  } catch (err) {
    console.error("[/importaciones/:id/log-errores]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
