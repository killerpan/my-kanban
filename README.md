# Kanban para intranet

Tablero kanban multiusuario, autoalojado, con login opcional contra Active Directory, pensado para correr dentro de una red interna sin depender de internet: no carga fuentes, scripts ni imágenes externas. Backend en Node.js (Express) con SQLite y frontend en JavaScript sin framework ni paso de compilación.

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

Roles por tablero: el **dueño** administra miembros, renombra y elimina el tablero; el **editor** crea, edita, mueve y borra tarjetas y columnas; el **lector** mira y comenta, sin poder mover ni editar. Un tablero siempre conserva al menos un dueño, y el sistema siempre conserva al menos un administrador activo.

Desactivar una cuenta o cambiarle la contraseña cierra sus sesiones abiertas de inmediato.

## Login con Active Directory

Opcional. Completa la sección LDAP de `.env` y reinicia (`docker compose up -d`). Al estar activo:

- La gente entra con su usuario de red (`jperez`, `EMPRESA\jperez` o `jperez@empresa.local`) y la misma contraseña de su computador. La cuenta se crea sola en su primer ingreso, con el nombre del directorio, salvo que pongas `LDAP_AUTO_CREATE=false`.
- `LDAP_ALLOWED_GROUP_DN` limita quién puede entrar y `LDAP_ADMIN_GROUP_DN` define los administradores. Los grupos anidados funcionan.
- Las cuentas locales siguen funcionando y siempre se validan primero. Conserva el admin local como acceso de emergencia: si el directorio no responde, es la única forma de entrar.
- Las contraseñas de red no se guardan ni se pueden cambiar en el tablero. Desactivar una cuenta en la pantalla Usuarios le bloquea el acceso aunque siga activa en el directorio.
- Si un nombre de usuario existe como cuenta local y también en el directorio, se rechaza el ingreso de red para evitar que alguien tome una cuenta ajena; resuélvelo renombrando la cuenta local.

Para la cuenta de servicio basta un usuario de dominio común sin privilegios. Con certificados de una CA interna, monta el `.pem` en el contenedor (por ejemplo, agrega `- ./certs:/certs:ro` en `volumes`) y define `LDAP_CA_FILE=/certs/ca-empresa.pem`.

Si el login falla, revisa `docker compose logs kanban`: los errores de conexión con el directorio quedan registrados ahí.

## Funciones

Tableros con columnas configurables (nombre, orden y límite de tarjetas en curso, con un medidor que avisa al acercarse y se marca en rojo al excederse). Tarjetas con título, descripción, persona asignada, fecha límite (se resalta si vence pronto o ya venció) y color. Las tarjetas se arrastran entre columnas o se mueven desde el editor de la tarjeta, que también sirve con teclado.

Cada tarjeta tiene comentarios y un historial automático (quién la creó, movió, reasignó o cambió su título, fecha o color). Quien escribe un comentario puede borrarlo, y los dueños pueden borrar cualquiera.

Los cambios de otras personas aparecen al instante mediante Server-Sent Events; el indicador "En vivo" en el tablero muestra el estado de la conexión. Si se corta, el navegador reconecta solo y recupera lo que se perdió; como respaldo, el tablero se consulta igual cada minuto. Cuando alguien pierde el acceso a un tablero, su vista se cierra en el momento.

## Seguridad incluida

Contraseñas con bcrypt; sesión en cookie `HttpOnly` y `SameSite=Strict` firmada con JWT; bloqueo de 5 minutos tras 5 intentos fallidos de login; toda escritura exige la cabecera `X-Requested-With` (defensa CSRF); Content-Security-Policy estricta sin scripts ni estilos inline; el texto de los usuarios nunca se inserta como HTML. Los tableros a los que alguien no tiene acceso responden 404, para no revelar que existen.

Si publicas la app por HTTPS detrás de un proxy inverso (nginx, Traefik, IIS), define `COOKIE_SECURE=true` y `TRUST_PROXY=true` en `.env`.

Con nginx, la ruta del tiempo real necesita que no se acumule la respuesta. La app ya envía `X-Accel-Buffering: no`, pero si tu configuración lo ignora, agrega para `/api/`:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

En IIS con ARR, desactiva el almacenamiento en búfer de respuesta para el sitio (`responseBufferLimit="0"`).

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
src/db.js       Esquema SQLite, migraciones y administrador inicial
src/ldap.js     Autenticación contra Active Directory / LDAP
src/realtime.js Avisos en vivo por tablero (Server-Sent Events)
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
| GET | `/boards/:id/stream` | lector (Server-Sent Events) |
| GET | `/cards/:id/activity` | lector |
| POST | `/cards/:id/comments` | lector |
| DELETE | `/comments/:id` | autor o dueño |
| GET | `/auth/config` | público |

## Límites conocidos

Si dos personas editan la misma tarjeta a la vez, gana la última en guardar. El tiempo real vive en la memoria de un solo proceso: no sirve tal cual con varias réplicas detrás de un balanceador (haría falta Redis o similar). SQLite rinde bien para equipos de decenas de personas; para cientos de usuarios concurrentes conviene migrar a PostgreSQL. Los comentarios no se pueden editar, solo borrar.

## Actualizar desde la versión 1.0

```bash
docker compose up -d --build
```

La base se migra sola al arrancar (agrega comentarios, historial y el tipo de cuenta) sin tocar los datos existentes. Haz un respaldo antes, por si acaso.
