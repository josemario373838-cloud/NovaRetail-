const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const auditoriaService = require("../services/auditoria");

const router = express.Router();
const SALT_ROUNDS = 12;
const MAX_INTENTOS = 3;
const BLOQUEO_MINUTOS = 30;

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// ---------------------------------------------------------------------------

router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email y password son requeridos" });
  }

  try {
    const { rows } = await db.query(
      "SELECT * FROM usuarios WHERE email = $1 AND activo = true",
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      // No revelar si el email existe o no (seguridad)
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const user = rows[0];

    // Verificar bloqueo temporal
    if (user.bloqueado_hasta && new Date() < new Date(user.bloqueado_hasta)) {
      return res.status(401).json({
        error: "Cuenta bloqueada temporalmente. Intenta en 30 minutos.",
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      const intentos = user.intentos_fallidos + 1;
      const bloqueo =
        intentos >= MAX_INTENTOS
          ? new Date(Date.now() + BLOQUEO_MINUTOS * 60 * 1000)
          : null;

      await db.query(
        "UPDATE usuarios SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3",
        [intentos, bloqueo, user.id]
      );

      await auditoriaService.registrar(user.id, "LOGIN_FALLIDO", req.ip, {
        intentos,
      });

      if (intentos >= MAX_INTENTOS) {
        return res
          .status(401)
          .json({ error: "Cuenta bloqueada temporalmente. Intenta en 30 minutos." });
      }

      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    // Credenciales correctas: resetear intentos
    await db.query(
      "UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1",
      [user.id]
    );

    const token = jwt.sign(
      { id: user.id, rol: user.rol, nombre: user.nombre },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    await auditoriaService.registrar(user.id, "LOGIN_EXITOSO", req.ip, {});

    return res.status(200).json({
      token,
      user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
    });
  } catch (err) {
    console.error("[POST /auth/login]", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/hash-password  (utilidad para crear usuarios iniciales)
// Solo disponible en desarrollo
// ---------------------------------------------------------------------------

router.post("/auth/hash-password", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "password requerido" });
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  return res.status(200).json({ hash });
});

module.exports = router;
