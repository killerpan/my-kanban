// Autenticación contra Active Directory (o cualquier LDAP).
// Flujo: la cuenta de servicio busca al usuario -> se valida su contraseña con un bind
// como ese usuario -> se revisa la pertenencia a grupos -> se devuelve su perfil.
const fs = require('fs');
const { Client } = require('ldapts');

const env = process.env;
const enabled = !!env.LDAP_URL;

const config = {
  url: env.LDAP_URL,
  bindDN: env.LDAP_BIND_DN || '',
  bindPassword: env.LDAP_BIND_PASSWORD || '',
  baseDN: env.LDAP_BASE_DN || '',
  userFilter: env.LDAP_USER_FILTER || '(&(objectCategory=person)(objectClass=user)(sAMAccountName={{username}}))',
  nameAttr: env.LDAP_DISPLAY_NAME_ATTR || 'displayName',
  allowedGroup: env.LDAP_ALLOWED_GROUP_DN || '',
  adminGroup: env.LDAP_ADMIN_GROUP_DN || '',
  // AD resuelve grupos anidados con LDAP_MATCHING_RULE_IN_CHAIN; otros servidores pueden no soportarlo.
  nestedGroups: env.LDAP_NESTED_GROUPS !== 'false',
  startTLS: env.LDAP_STARTTLS === 'true',
  autoCreate: env.LDAP_AUTO_CREATE !== 'false',
  tlsOptions: {
    rejectUnauthorized: env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false',
    ca: env.LDAP_CA_FILE ? [fs.readFileSync(env.LDAP_CA_FILE)] : undefined,
  },
};

if (enabled) {
  const missing = ['LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_BASE_DN'].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`LDAP_URL está definido pero faltan: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (config.url.startsWith('ldap://') && !config.startTLS) {
    console.warn('LDAP sin cifrar: las contraseñas viajan en texto plano. Usa ldaps:// o LDAP_STARTTLS=true.');
  }
  console.log(`Login con directorio activo habilitado (${config.url}).`);
}

/** Escapa un valor para usarlo dentro de un filtro LDAP (RFC 4515). */
function escapeFilter(value) {
  return String(value).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Acepta "usuario", "DOMINIO\usuario" o "usuario@dominio" y devuelve "usuario". */
function normalizeUsername(raw) {
  let u = String(raw).trim();
  if (u.includes('\\')) u = u.split('\\').pop();
  if (u.includes('@')) u = u.split('@')[0];
  return u;
}

function newClient() {
  // Ojo: si ldapts recibe tlsOptions, abre TLS directo aunque la URL sea ldap://.
  // Por eso solo se pasan con ldaps://; con STARTTLS se entregan en startTLS().
  return new Client({
    url: config.url,
    timeout: 8000,
    connectTimeout: 5000,
    tlsOptions: config.url.startsWith('ldaps://') ? config.tlsOptions : undefined,
  });
}

async function withClient(fn) {
  const client = newClient();
  try {
    if (config.startTLS) await client.startTLS(config.tlsOptions);
    return await fn(client);
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** Lee un atributo sin importar mayúsculas (LDAP no distingue, pero los servidores varían). */
// ldapts deja como [] los atributos pedidos que no llegaron con esa capitalización exacta,
// así que se toma el primer valor no vacío entre todas las claves equivalentes.
function attr(entry, name) {
  for (const [k, v] of Object.entries(entry)) {
    if (k.toLowerCase() !== name.toLowerCase()) continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

async function inGroup(client, userDN, groupDN) {
  const filter = config.nestedGroups
    ? `(memberOf:1.2.840.113556.1.4.1941:=${escapeFilter(groupDN)})`
    : `(memberOf=${escapeFilter(groupDN)})`;
  const { searchEntries } = await client.search(userDN, { scope: 'base', filter, attributes: ['dn'] });
  return searchEntries.length > 0;
}

/**
 * Valida credenciales contra el directorio.
 * Devuelve { username, displayName, isAdmin } o null si las credenciales no son válidas
 * o la persona no pertenece al grupo permitido. Lanza error si el directorio no responde.
 */
async function authenticate(rawUsername, password) {
  if (!enabled) return null;
  const username = normalizeUsername(rawUsername);
  // Un bind con contraseña vacía es un bind anónimo y "funciona": nunca lo aceptes.
  if (!username || !password) return null;

  return withClient(async (client) => {
    await client.bind(config.bindDN, config.bindPassword);

    const filter = config.userFilter.replaceAll('{{username}}', escapeFilter(username));
    const { searchEntries } = await client.search(config.baseDN, {
      scope: 'sub',
      filter,
      sizeLimit: 2,
      attributes: ['dn', 'sAMAccountName', 'uid', config.nameAttr, 'cn'],
    });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0];

    // Valida la contraseña en una conexión aparte, como el propio usuario.
    try {
      await withClient((userClient) => userClient.bind(entry.dn, password));
    } catch (err) {
      if (err && (err.code === 49 || /InvalidCredentials/i.test(err.name || ''))) return null;
      throw err;
    }

    if (config.allowedGroup && !(await inGroup(client, entry.dn, config.allowedGroup))) return null;
    const isAdmin = config.adminGroup ? await inGroup(client, entry.dn, config.adminGroup) : null;

    return {
      username: String(attr(entry, 'sAMAccountName') || attr(entry, 'uid') || username).toLowerCase(),
      displayName: String(attr(entry, config.nameAttr) || attr(entry, 'cn') || username),
      isAdmin, // null = no hay grupo de administradores configurado; se respeta el rol local
    };
  });
}

module.exports = { enabled, authenticate, normalizeUsername, escapeFilter, autoCreate: config.autoCreate };
