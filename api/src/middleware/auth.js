const jwt = require("jsonwebtoken");

/**
 * Middleware de autenticación JWT.
 * @param {string[]} allowedRoles - Roles autorizados para el endpoint.
 */
function authMiddleware(allowedRoles = []) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token no proporcionado" });
    }

    const token = authHeader.split(" ")[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;

      if (allowedRoles.length > 0 && !allowedRoles.includes(decoded.rol)) {
        return res.status(403).json({
          error: "Acceso prohibido: rol insuficiente",
          rol_requerido: allowedRoles,
          rol_actual: decoded.rol,
        });
      }

      return next();
    } catch (err) {
      return res.status(401).json({ error: "Token inválido o expirado" });
    }
  };
}

module.exports = authMiddleware;
