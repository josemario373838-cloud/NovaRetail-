const express = require("express");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const db = require("../config/db");
const authMiddleware = require("../middleware/auth");
const auditoriaService = require("../services/auditoria");

const router = express.Router();
const SALT_ROUNDS = 12;
const ROLES_VALIDOS = ["administrador", "gerente", "supervisor"];

// ---------------------------------------------------------------------------
// GET /api/v1/usuarios
// ---------------------------------------------------------------------------

router.get("/usuarios", authMiddleware(["administrador"]), async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, nombre, rol, activo, created_at, updated_at
       FROM usuarios ORDER BY created_at DESC`
    );
    return res.status(200).json(rows);
  } catch (err) {
    console.error("[GET /usuarios]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/usuarios
// ---------------------------------------------------------------------------

router.post("/usuarios", authMiddleware(["administrador"]), async (req, res) => {
  try {
    const { email, nombre, password, rol } = req.body;

    if (!email || !nombre || !password || !rol) {
      return res
        .status(400)
        .json({ error: "email, nombre, password y rol son requeridos" });
    }

    if (!ROLES_VALIDOS.includes(rol)) {
      return res
        .status(400)
        .json({ error: `rol inválido. Valores: ${ROLES_VALIDOS.join(", ")}` });
    }

    // Verificar email duplicado
    const dup = await db.query("SELECT id FROM usuarios WHERE email = $1", [
      email.toLowerCase().trim(),
    ]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: "El email ya está registrado" });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = uuidv4();

    await db.query(
      `INSERT INTO usuarios (id, email, password_hash, nombre, rol, activo, intentos_fallidos)
       VALUES ($1, $2, $3, $4, $5, true, 0)`,
      [id, email.toLowerCase().trim(), passwordHash, nombre.trim(), rol]
    );

    await auditoriaService.registrar(req.user.id, "USUARIO_CREADO", req.ip, {
      nuevo_usuario_id: id,
      email,
      rol,
    });

    return res.status(201).json({ id, email, nombre, rol, activo: true });
  } catch (err) {
    console.error("[POST /usuarios]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/usuarios/:id
// ---------------------------------------------------------------------------

router.patch("/usuarios/:id", authMiddleware(["administrador"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, rol, activo, password } = req.body;

    if (rol && !ROLES_VALIDOS.includes(rol)) {
      return res
        .status(400)
        .json({ error: `rol inválido. Valores: ${ROLES_VALIDOS.join(", ")}` });
    }

    // Impedir que el admin se auto-modifique el rol/activo
    if (id === req.user.id && activo === false) {
      return res
        .status(400)
        .json({ error: "No puedes desactivar tu propio usuario" });
    }

    const updates = [];
    const params = [];
    let i = 1;

    if (nombre !== undefined) {
      updates.push(`nombre = $${i++}`);
      params.push(nombre.trim());
    }
    if (rol !== undefined) {
      updates.push(`rol = $${i++}`);
      params.push(rol);
    }
    if (activo !== undefined) {
      updates.push(`activo = $${i++}`);
      params.push(activo);
    }
    if (password !== undefined) {
      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      updates.push(`password_hash = $${i++}`);
      params.push(hash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No hay campos para actualizar" });
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await db.query(
      `UPDATE usuarios SET ${updates.join(", ")} WHERE id = $${i} RETURNING id, email, nombre, rol, activo`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    await auditoriaService.registrar(req.user.id, "USUARIO_EDITADO", req.ip, {
      usuario_id: id,
      cambios: { nombre, rol, activo },
    });

    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error("[PATCH /usuarios/:id]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/usuarios/:id  (soft delete)
// ---------------------------------------------------------------------------

router.delete("/usuarios/:id", authMiddleware(["administrador"]), async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.user.id) {
      return res
        .status(400)
        .json({ error: "No puedes eliminar tu propio usuario" });
    }

    const { rows } = await db.query(
      `UPDATE usuarios SET activo = false, updated_at = NOW()
       WHERE id = $1 AND activo = true
       RETURNING id, email, nombre, rol, activo`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado o ya inactivo" });
    }

    await auditoriaService.registrar(req.user.id, "USUARIO_ELIMINADO", req.ip, {
      usuario_id: id,
    });

    return res.status(200).json({ mensaje: "Usuario desactivado correctamente", ...rows[0] });
  } catch (err) {
    console.error("[DELETE /usuarios/:id]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
