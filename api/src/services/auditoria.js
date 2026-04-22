const { v4: uuidv4 } = require("uuid");
const db = require("../config/db");

/**
 * Registra una acción en la tabla auditoria.
 * @param {string|null} usuarioId - UUID del usuario que ejecuta la acción.
 * @param {string} accion - Código de la acción (ej. 'LOGIN_EXITOSO').
 * @param {string} ipOrigen - IP del cliente.
 * @param {object} metadata - Datos adicionales en JSON.
 */
async function registrar(usuarioId, accion, ipOrigen = null, metadata = {}) {
  try {
    await db.query(
      `INSERT INTO auditoria (id, usuario_id, accion, ip_origen, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), usuarioId || null, accion, ipOrigen || null, JSON.stringify(metadata)]
    );
  } catch (err) {
    // Auditoría no debe bloquear el flujo principal
    console.error("[AuditoriaService] Error al registrar:", err.message);
  }
}

module.exports = { registrar };
