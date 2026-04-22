const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const [, , hash] = process.argv;
    const result = await pool.query(
      `UPDATE usuarios SET password_hash = $1, intentos_fallidos = 0, bloqueado_hasta = NULL
       WHERE email = 'admin@novaretail.com'
       RETURNING id, email, nombre, rol, activo`,
      [hash]
    );
    if (result.rows.length > 0) {
      console.log("Hash actualizado:", JSON.stringify(result.rows[0]));
    } else {
      console.log("Usuario no encontrado");
    }
    process.exit(0);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
})();
