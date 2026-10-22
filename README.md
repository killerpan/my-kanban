# Kanban para intranet

Tablero kanban multiusuario, autoalojado, pensado para correr dentro de una red interna sin depender de internet: no carga fuentes, scripts ni imágenes externas. Backend en Node.js (Express) con SQLite y frontend en JavaScript sin framework ni paso de compilación.

## Puesta en marcha

```bash
cp .env.example .env
# Edita .env: define JWT_SECRET (openssl rand -hex 32) y ADMIN_PASSWORD (mínimo 8 caracteres)
docker compose up -d --build
```

La app queda en `http://<servidor>:8080`. Entra con el administrador definido en `.env`; ese usuario solo se crea en el primer arranque, cuando la base está vacía. Después de entrar, cambia la contraseña desde la barra superior y crea las cuentas del equipo en **Usuarios**.

Para cambiar el puerto, edita `ports` en `docker-compose.yml` (por ejemplo `"80:3000"`).

## Permisos

Hay dos niveles independientes.

Roles globales: el **administrador** crea, edita y desactiva cuentas, y ve todos los tableros con permisos de dueño. El **usuario** ve solo los tableros donde es miembro y puede crear tableros propios. No existe registro abierto: solo un administrador crea cuentas.

Roles por tablero: el **dueño** administra miembros, renombra y elimina el tablero; el **editor** crea, edita, mueve y borra tarjetas y columnas; el **lector** solo mira. Un tablero siempre conserva al menos un dueño, y el sistema siempre conserva al menos un administrador activo.

Desactivar una cuenta o cambiarle la contraseña cierra sus sesiones abiertas de inmediato.

## Funciones

Tableros con columnas configurables (nombre, orden y límite de tarjetas en curso, con un medidor que avisa al acercarse y se marca en rojo al excederse). Tarjetas con título, descripción, persona asignada, fecha límite (se resalta si vence pronto o ya venció) y color. Las tarjetas se arrastran entre columnas o se mueven desde el editor de la tarjeta, que también sirve con teclado. Los cambios de otras personas aparecen solos cada 10 segundos mientras el tablero está abierto.

## Seguridad incluida

Contraseñas con bcrypt; sesión en cookie `HttpOnly` y `SameSite=Strict` firmada con JWT; bloqueo de 5 minutos tras 5 intentos fallidos de login; toda escritura exige la cabecera `X-Requested-With` (defensa CSRF); Content-Security-Policy estricta sin scripts ni estilos inline; el texto de los usuarios nunca se inserta como HTML. Los tableros a los que alguien no tiene acceso responden 404, para no revelar que existen.

Si publicas la app por HTTPS detrás de un proxy inverso (nginx, Traefik, IIS), define `COOKIE_SECURE=true` y `TRUST_PROXY=true` en `.env`.

## Respaldos

Los datos viven en el volumen `kanban-data` (archivo `/data/kanban.db`). Para un respaldo consistente con la app en marcha:

```bash
docker compose exec kanban node src/backup.js
# queda en /data/backups/kanban-AAAA-MM-DDTHH-MM-SS.db dentro del volumen

# copiarlo al host:
docker compose cp kanban:/data/backups ./backups
```

Para programarlo, agrega esa línea a un cron del host. No copies `kanban.db` directamente mientras la app corre: SQLite trabaja en modo WAL y la copia puede quedar incompleta.

Para restaurar: detén la app (`docker compose stop`), copia el respaldo como `/data/kanban.db` (borrando `kanban.db-wal` y `kanban.db-shm` si existen) y vuelve a levantarla.

## Desarrollo local sin Docker

```bash
npm install
ADMIN_PASSWORD=cambiar123 JWT_SECRET=dev npm run dev
```

Queda en `http://localhost:3000` y guarda la base en `./data`.

## Estructura

```
src/server.js   Express, cabeceras de seguridad, CSRF y archivos estáticos
src/auth.js     Login, sesiones, cambio de contraseña, límite de intentos
src/routes.js   API: usuarios, tableros, miembros, columnas y tarjetas
src/db.js       Esquema SQLite y creación del administrador inicial
src/backup.js   Respaldo en caliente
public/         Interfaz (index.html, app.js, styles.css)
```

## API

Todas las rutas van bajo `/api`, requieren sesión salvo el login, y las escrituras requieren la cabecera `X-Requested-With: kanban`.

| Método | Ruta | Permiso |
|---|---|---|
| POST | `/auth/login`, `/auth/logout` | público |
| GET | `/auth/me` | sesión |
| POST | `/auth/password` | sesión |
| GET | `/users/directory` | sesión |
| GET, POST | `/users` | admin |
| PATCH | `/users/:id` | admin |
| GET, POST | `/boards` | sesión |
| GET | `/boards/:id` | lector |
| PATCH, DELETE | `/boards/:id` | dueño |
| PUT, DELETE | `/boards/:id/members/:userId` | dueño |
| POST | `/boards/:id/columns`, `/boards/:id/columns/reorder` | editor |
| PATCH, DELETE | `/columns/:id` | editor |
| POST | `/columns/:id/cards` | editor |
| PATCH, DELETE | `/cards/:id` | editor |
| POST | `/cards/:id/move` | editor |

## Límites conocidos

La sincronización es por consulta periódica, no en tiempo real: si dos personas editan la misma tarjeta a la vez, gana el último en guardar. SQLite rinde bien para equipos de decenas de personas; para cientos de usuarios concurrentes conviene migrar a PostgreSQL. No hay historial de cambios ni comentarios en tarjetas.
