const STORAGE_KEY = 'fleetguard-data-v3';

// ============================================================
// SUPABASE AUTH
// Supabase gestiona el acceso y los perfiles. Los módulos
// operativos continúan en localStorage hasta la siguiente etapa.
// ============================================================
const fleetguardConfig = window.FLEETGUARD_CONFIG || {};
let supabaseClient = null;
let currentProfile = null;
let authTransition = Promise.resolve();
let preUseRealtimeChannel = null;

const roleLabels = {
  admin: 'Administrador',
  flota: 'Flota / Logística',
  rrhh: 'Recursos Humanos',
  ssoma: 'SSOMA',
  conductor: 'Conductor',
  consulta: 'Solo consulta'
};

const q = (id) => document.getElementById(id);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

function isSupabaseConfigured() {
  const url = String(fleetguardConfig.supabaseUrl || '').trim();
  const key = String(fleetguardConfig.supabasePublishableKey || '').trim();
  return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)
    && key.length > 20
    && !url.includes('TU_PROYECTO')
    && !key.includes('TU_PUBLISHABLE_KEY');
}

function setAuthMessage(message = '', type = 'error') {
  const el = q('authMessage');
  el.textContent = message;
  el.classList.toggle('success', type === 'success');
}

function setLoginLoading(isLoading) {
  const button = q('loginButton');
  const form = q('loginForm');
  button.disabled = isLoading || !isSupabaseConfigured();
  button.textContent = isLoading ? 'Validando acceso...' : 'Ingresar a FleetGuard';
  form.setAttribute('aria-busy', String(isLoading));
}

function showLoginScreen(message = '') {
  q('authScreen').hidden = false;
  q('appShell').hidden = true;
  document.body.style.overflow = '';
  closeNotificationPanel();
  if (message) setAuthMessage(message);
}

function showApplication() {
  q('authScreen').hidden = true;
  q('appShell').hidden = false;
  q('connectionStatus').textContent = 'Sesión protegida';
  q('dataModeLabel').textContent = 'Supabase Auth / chequeos en nube';
  renderAll();
  loadPreUseChecksFromSupabase({ silent: true });
  subscribePreUseRealtime();
}

function updateUserInterface(user, profile) {
  const displayName = profile?.full_name?.trim() || user.email?.split('@')[0] || 'Usuario';
  q('currentUserName').textContent = displayName;
  q('currentUserRole').textContent = roleLabels[profile?.role] || profile?.role || 'Usuario';
  q('currentUserInitials').textContent = initials(displayName) || 'US';
}

async function loadCurrentProfile(user) {
  const { data: profile, error } = await supabaseClient
    .from('user_profiles')
    .select('id, full_name, role, is_active, driver_id')
    .eq('id', user.id)
    .single();

  if (error) throw new Error('No se pudo consultar el perfil. Comprueba el script de usuarios y RLS.');
  if (!profile.is_active) throw new Error('Tu usuario está desactivado. Comunícate con el administrador.');
  return profile;
}

async function applySession(session) {
  if (!session?.user) {
    currentProfile = null;
    showLoginScreen();
    return;
  }

  try {
    currentProfile = await loadCurrentProfile(session.user);
    updateUserInterface(session.user, currentProfile);
    setAuthMessage('');
    showApplication();
  } catch (error) {
    currentProfile = null;
    await supabaseClient.auth.signOut();
    showLoginScreen(error.message || 'No fue posible validar tu perfil.');
  }
}

async function initializeFleetGuard() {
  q('configWarning').hidden = isSupabaseConfigured();
  setLoginLoading(false);

  if (!isSupabaseConfigured()) {
    showLoginScreen('Configura primero la URL y la Publishable Key de Supabase.');
    return;
  }
  if (!window.supabase?.createClient) {
    showLoginScreen('No se pudo cargar la librería de Supabase. Revisa tu conexión a internet.');
    return;
  }

  supabaseClient = window.supabase.createClient(
    fleetguardConfig.supabaseUrl,
    fleetguardConfig.supabasePublishableKey,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
  );

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    authTransition = authTransition
      .then(() => applySession(session))
      .catch((error) => showLoginScreen(error.message || 'Error al actualizar la sesión.'));
  });

  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error) {
    showLoginScreen('No se pudo recuperar la sesión guardada.');
    return;
  }
  await applySession(session);
}

const initialData = {
  vehicles: [],
  drivers: [],
  assignments: [],
  documents: [],
  incidents: [],
  maintenance: [],
  returns: [],
  preUseChecks: []
};

let data = loadData();

// Compatibilidad con versiones anteriores guardadas en el navegador.
if (!Array.isArray(data.preUseChecks)) {
  data.preUseChecks = [];
  saveData();
}

function cloneInitialData() {
  return JSON.parse(JSON.stringify(initialData));
}

function loadData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : cloneInitialData();
  } catch {
    return cloneInitialData();
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function ensureAssignmentSnapshots() {
  let changed = false;
  data.assignments.forEach((assignment) => {
    const driver = data.drivers.find((item) => item.id === Number(assignment.driverId));
    if (!assignment.driverNameSnapshot && driver?.name) { assignment.driverNameSnapshot = driver.name; changed = true; }
    if (!assignment.driverDniSnapshot && driver?.dni) { assignment.driverDniSnapshot = driver.dni; changed = true; }
    if (!assignment.teamSnapshot) { assignment.teamSnapshot = assignment.team || driver?.team || ''; changed = true; }
    if (!assignment.zoneSnapshot) { assignment.zoneSnapshot = assignment.zone || driver?.zone || ''; changed = true; }
  });
  if (changed) saveData();
}

ensureAssignmentSnapshots();


const FILE_DB_NAME = 'fleetguard-local-files';
const FILE_DB_VERSION = 1;
const FILE_STORE_NAME = 'files';
let fileDbPromise = null;

function openFileDatabase() {
  if (fileDbPromise) return fileDbPromise;
  fileDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(FILE_DB_NAME, FILE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE_NAME)) {
        db.createObjectStore(FILE_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir el almacén de archivos.'));
  });
  return fileDbPromise;
}

async function saveLocalFile(file, key) {
  if (!file) return null;
  const maxSize = 25 * 1024 * 1024;
  if (file.size > maxSize) throw new Error('El archivo supera el límite temporal de 25 MB.');
  const db = await openFileDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE_NAME, 'readwrite');
    transaction.objectStore(FILE_STORE_NAME).put({
      key,
      blob: file,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      updatedAt: new Date().toISOString()
    });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar el archivo.'));
  });
  return key;
}

async function getLocalFile(key) {
  if (!key) return null;
  const db = await openFileDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE_NAME, 'readonly');
    const request = transaction.objectStore(FILE_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('No se pudo leer el archivo.'));
  });
}

async function openStoredFile(key, title = 'Archivo') {
  try {
    const record = await getLocalFile(key);
    if (!record?.blob) {
      toast('El archivo físico no está disponible en este navegador.');
      return;
    }
    const modal = q('fileViewerModal');
    if (modal.dataset.objectUrl) URL.revokeObjectURL(modal.dataset.objectUrl);
    const url = URL.createObjectURL(record.blob);
    modal.dataset.objectUrl = url;
    q('fileViewerTitle').textContent = title;
    q('fileViewerName').textContent = `${record.name} · ${(record.size / 1024 / 1024).toFixed(2)} MB`;
    const download = q('fileDownloadButton');
    download.href = url;
    download.download = record.name;
    const type = String(record.type || '');
    if (type.startsWith('image/')) {
      q('fileViewerContent').innerHTML = `<img src="${url}" alt="${escapeHtml(title)}">`;
    } else if (type === 'application/pdf' || record.name.toLowerCase().endsWith('.pdf')) {
      q('fileViewerContent').innerHTML = `<iframe src="${url}#toolbar=1&navpanes=1" title="${escapeHtml(title)}"></iframe>`;
    } else {
      q('fileViewerContent').innerHTML = '<div class="file-viewer-placeholder"><strong>Vista previa no disponible</strong><p>Utiliza el botón Descargar para abrir este tipo de archivo.</p></div>';
    }
    openModal('fileViewerModal');
  } catch (error) {
    toast(error.message || 'No se pudo abrir el archivo.');
  }
}

function fileButton(record, label = 'Visualizar archivo') {
  if (!record?.fileStorageKey) {
    return `<button class="row-action file-action-button" type="button" disabled title="El archivo físico no está guardado en este navegador">${escapeHtml(record?.file || 'Sin archivo')}</button>`;
  }
  return `<button class="row-action file-action-button" type="button" data-open-file="${escapeHtml(record.fileStorageKey)}" data-file-title="${escapeHtml(label)}">Visualizar</button>`;
}

function vehicleById(id) { return data.vehicles.find((v) => v.id === Number(id)); }
function driverById(id) { return data.drivers.find((d) => d.id === Number(id)); }
function assignmentById(id) { return data.assignments.find((a) => a.id === Number(id)); }

function assignmentDriverName(assignment) {
  return assignment?.driverNameSnapshot || driverById(assignment?.driverId)?.name || 'Sin conductor';
}
function assignmentDriverDni(assignment) {
  return assignment?.driverDniSnapshot || driverById(assignment?.driverId)?.dni || 'Sin DNI';
}
function assignmentEndDate(assignment) {
  if (!assignment) return null;
  if (assignment.returnedAt) return assignment.returnedAt;
  if (assignment.status === 'Cerrada') return assignment.expectedReturn || assignment.date;
  return null;
}
function findAssignmentAtDate(vehicleId, dateValue) {
  if (!vehicleId || !dateValue) return null;
  const date = String(dateValue).slice(0, 10);
  return [...data.assignments]
    .filter((assignment) => Number(assignment.vehicleId) === Number(vehicleId))
    .filter((assignment) => {
      const start = String(assignment.date || '').slice(0, 10);
      const end = assignmentEndDate(assignment);
      return start && date >= start && (!end || date <= String(end).slice(0, 10));
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;
}
function incidentResponsible(incident) {
  if (incident?.responsibleName) {
    return {
      assignmentId: incident.assignmentId || null,
      name: incident.responsibleName,
      dni: incident.responsibleDni || 'Sin DNI',
      team: incident.responsibleTeam || '',
      zone: incident.responsibleZone || '',
      start: incident.assignmentStart || '',
      end: incident.assignmentEnd || ''
    };
  }
  const assignment = findAssignmentAtDate(incident?.vehicleId, incident?.date);
  if (!assignment) return null;
  return {
    assignmentId: assignment.id,
    name: assignmentDriverName(assignment),
    dni: assignmentDriverDni(assignment),
    team: assignment.teamSnapshot || assignment.team || '',
    zone: assignment.zoneSnapshot || assignment.zone || '',
    start: assignment.date || '',
    end: assignmentEndDate(assignment) || ''
  };
}
function normalize(value = '') {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function includesTerm(values, term) {
  if (!term) return true;
  return normalize(values.filter((v) => v !== null && v !== undefined).join(' ')).includes(normalize(term));
}
function slug(value = '') { return normalize(value).replace(/\s+/g, '-'); }
function money(value) { return new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', maximumFractionDigits: 2 }).format(Number(value || 0)); }
function formatDate(value) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
}
function initials(name = '') { return name.split(' ').filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase(); }
function nextId(list) { return list.length ? Math.max(...list.map((item) => Number(item.id))) + 1 : 1; }
function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

const ICON_FILES = {
  dashboard: 'dasboard.png',
  alert: 'alerta.png',
  vehicle: 'unidades.png',
  driver: 'conductor.png',
  assignment: 'asignar.png',
  preuse: 'chequeo.png',
  document: 'documento.png',
  incident: 'incidente.png',
  maintenance: 'mantenimiento.png',
  return: 'devolucion.png',
  report: 'reportes.png',
  search: 'buscar.png'
};

function iconToken(name, fallback = '', className = '') {
  const file = ICON_FILES[name] || name || '';
  const classes = ['icon-chip', className].filter(Boolean).join(' ');
  return `<span class="${classes}"><img class="icon-chip-image" src="assets/icons/${file}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="icon-chip-fallback" hidden>${escapeHtml(fallback)}</span></span>`;
}

function typeIconName(type) {
  return ({
    vehicle: 'vehicle',
    driver: 'driver',
    assignment: 'assignment',
    preuse: 'preuse',
    document: 'document',
    incident: 'incident',
    maintenance: 'maintenance',
    return: 'return',
    alert: 'alert'
  }[type] || 'dashboard');
}

const titles = {
  dashboard: ['Resumen general', 'Panel principal'],
  vehicles: ['Inventario', 'Unidades vehiculares'],
  drivers: ['Personal autorizado', 'Conductores'],
  assignments: ['Trazabilidad', 'Asignaciones'],
  preuse: ['Control operativo', 'Chequeo pre-uso'],
  documents: ['Cumplimiento', 'Documentos'],
  incidents: ['Operación', 'Incidentes'],
  maintenance: ['Taller y costos', 'Mantenimiento'],
  returns: ['Cierre de uso', 'Devoluciones'],
  reports: ['Análisis', 'Reportes']
};

function switchView(viewId) {
  if (!titles[viewId]) return;
  qa('.view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  qa('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
  q('pageEyebrow').textContent = titles[viewId][0];
  q('pageTitle').textContent = titles[viewId][1];
  q('sidebar').classList.remove('open');
  closeNotificationPanel();
  hideGlobalSearchResults();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function statusClass(status) {
  const map = {
    Disponible: 'available', Asignada: 'assigned', Mantenimiento: 'maintenance',
    'Pendiente de devolución': 'pending', Devuelta: 'returned', Vigente: 'valid',
    'Por vencer': 'warning', Vencido: 'expired', Activa: 'active', Cerrada: 'closed',
    Pendiente: 'pending', Abierto: 'open', 'En proceso': 'in-progress', Cerrado: 'closed',
    Programado: 'pending', Completado: 'completed', Cancelado: 'expired', Habilitado: 'valid', Confirmado: 'active', Reprogramado: 'warning', 'Correo enviado': 'assigned',
    Conforme: 'valid', 'Con observaciones': 'warning'
  };
  return map[status] || 'pending';
}

function getNotifications() {
  const items = [];
  data.documents.filter((doc) => doc.status !== 'Vigente').forEach((doc) => {
    const vehicle = vehicleById(doc.vehicleId);
    items.push({
      type: 'document', id: doc.id, view: 'documents', priority: doc.status === 'Vencido' ? 1 : 2,
      title: `${doc.type}: ${vehicle?.plate || 'Unidad'}`,
      meta: `${doc.status} / vence ${formatDate(doc.expiry)}`
    });
  });
  data.incidents.filter((incident) => incident.status !== 'Cerrado').forEach((incident) => {
    const vehicle = vehicleById(incident.vehicleId);
    items.push({
      type: 'incident', id: incident.id, view: 'incidents', priority: incident.severity === 'Alta' ? 1 : 2,
      title: `${incident.type}: ${vehicle?.plate || 'Unidad'}`,
      meta: `${incident.status} / gravedad ${incident.severity}`
    });
  });
  data.returns.filter((item) => item.status !== 'Devuelto').forEach((item) => {
    const assignment = assignmentById(item.assignmentId);
    const vehicle = vehicleById(assignment?.vehicleId);
    items.push({
      type: 'return', id: item.id, view: 'returns', priority: 2,
      title: `Devolución pendiente: ${vehicle?.plate || 'Unidad'}`,
      meta: `Fecha límite ${formatDate(item.dueDate)}`
    });
  });
  return items.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
}

function renderNotifications() {
  const notifications = getNotifications();
  q('notificationBadge').textContent = String(notifications.length);
  q('notificationBadge').hidden = notifications.length === 0;
  q('documentAlertCount').textContent = String(data.documents.filter((doc) => doc.status !== 'Vigente').length);
  q('notificationList').innerHTML = notifications.length
    ? notifications.map((item) => `
      <button class="notification-item" type="button" data-search-view="${item.view}" data-detail-type="${item.type}" data-detail-id="${item.id}">
        <span class="notification-type">${iconToken(item.type === 'document' ? 'document' : item.type === 'incident' ? 'incident' : 'return', item.type === 'document' ? 'DOC' : item.type === 'incident' ? 'INC' : 'DEV', 'tiny-chip')}</span>
        <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></span>
      </button>`).join('')
    : '<div class="empty-state"><strong>Sin alertas pendientes</strong>No existen acciones urgentes.</div>';
}

function renderStats() {
  const counts = {
    total: data.vehicles.length,
    assigned: data.vehicles.filter((v) => v.status === 'Asignada').length,
    maintenance: data.vehicles.filter((v) => v.status === 'Mantenimiento').length,
    alerts: data.documents.filter((d) => d.status !== 'Vigente').length
  };
  const stats = [
    ['UN', 'Total de unidades', counts.total, 'blue', 'Inventario'],
    ['AS', 'Unidades asignadas', counts.assigned, 'green', 'Operativas'],
    ['MA', 'En mantenimiento', counts.maintenance, 'orange', 'Seguimiento'],
    ['AL', 'Alertas pendientes', counts.alerts, 'red', 'Documentos']
  ];
  q('statsGrid').innerHTML = stats.map(([code, label, value, color, small]) => `
    <article class="stat-card">
      <div class="stat-icon ${color}">${code}</div>
      <div><span>${label}</span><strong>${value}</strong></div>
      <small>${small}</small>
    </article>`).join('');
}

function renderFleetDistribution() {
  const colors = { Disponible: '#198754', Asignada: '#164b8f', Mantenimiento: '#b85c24', 'Pendiente de devolución': '#6b4fa1' };
  q('fleetDistribution').innerHTML = Object.keys(colors).map((status) => {
    const count = data.vehicles.filter((v) => v.status === status).length;
    const percentage = data.vehicles.length ? Math.round((count / data.vehicles.length) * 100) : 0;
    return `<div class="fleet-row"><span>${status}</span><div class="progress"><span style="width:${percentage}%;background:${colors[status]}"></span></div><strong>${count}</strong></div>`;
  }).join('');
}

function renderDocumentAlerts() {
  const alerts = data.documents.filter((doc) => doc.status !== 'Vigente').slice(0, 4);
  q('documentAlerts').innerHTML = alerts.length
    ? alerts.map((doc) => {
      const vehicle = vehicleById(doc.vehicleId);
      return `<button class="alert-item alert-button" type="button" data-search-view="documents" data-detail-type="document" data-detail-id="${doc.id}"><div class="alert-icon">${iconToken('document', 'DOC', 'tiny-chip')}</div><div><strong>${escapeHtml(doc.type)}</strong><span>${escapeHtml(vehicle?.plate || 'Unidad')} / ${escapeHtml(doc.status)}</span></div><time>${formatDate(doc.expiry)}</time></button>`;
    }).join('')
    : '<div class="empty-state"><strong>Sin alertas</strong>Todos los documentos están vigentes.</div>';
}

function renderRecentAssignments() {
  q('recentAssignmentsTable').innerHTML = [...data.assignments]
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)
    .map((assignment) => {
      const vehicle = vehicleById(assignment.vehicleId);
      const driver = driverById(assignment.driverId);
      return `<tr><td><div class="vehicle-cell"><div class="vehicle-thumb">${iconToken('vehicle', 'UN', 'tiny-chip')}</div><div><strong>${escapeHtml(vehicle?.plate || 'Sin placa')}</strong><span>${escapeHtml(`${vehicle?.brand || ''} ${vehicle?.model || ''}`.trim())}</span></div></div></td><td>${escapeHtml(assignmentDriverName(assignment))}</td><td>${escapeHtml(assignment.teamSnapshot || assignment.team || '')}</td><td>${formatDate(assignment.date)}</td><td><span class="status ${statusClass(assignment.status)}">${escapeHtml(assignment.status)}</span></td></tr>`;
    }).join('');
}

function renderExpenseChart() {
  const chart = q('expenseChart');
  const totalElement = q('expenseTotal');
  if (!chart || !totalElement) return;

  const now = new Date();
  const months = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    months.push(new Date(now.getFullYear(), now.getMonth() - offset, 1));
  }

  const monthlyRent = data.vehicles
    .filter((vehicle) => vehicle.ownership === 'Alquilada' && Number(vehicle.rent || 0) > 0)
    .reduce((sum, vehicle) => sum + Number(vehicle.rent || 0), 0);

  const series = months.map((month) => {
    const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
    const maintenance = data.maintenance
      .filter((record) => String(record.entry || '').startsWith(key))
      .reduce((sum, record) => sum + Number(record.cost || 0), 0);
    return {
      label: month.toLocaleDateString('es-PE', { month: 'short' }).replace('.', ''),
      maintenance,
      rent: monthlyRent
    };
  });

  const current = series[series.length - 1] || { maintenance: 0, rent: 0 };
  totalElement.textContent = money(current.maintenance + current.rent);
  const maxValue = Math.max(0, ...series.flatMap((item) => [item.maintenance, item.rent]));

  if (maxValue <= 0) {
    chart.innerHTML = '<div class="expense-empty"><strong>Sin gastos registrados</strong><span>Los valores aparecerán al registrar alquileres o mantenimientos.</span></div>';
    return;
  }

  chart.innerHTML = series.map((item) => {
    const maintenanceHeight = item.maintenance > 0 ? Math.max(6, Math.round((item.maintenance / maxValue) * 100)) : 0;
    const rentHeight = item.rent > 0 ? Math.max(6, Math.round((item.rent / maxValue) * 100)) : 0;
    return `<div class="chart-column" title="${escapeHtml(item.label)} · Mantenimiento ${escapeHtml(money(item.maintenance))} · Alquiler ${escapeHtml(money(item.rent))}">
      <span style="height:${maintenanceHeight}%;background:#164b8f"></span>
      <span style="height:${rentHeight}%;background:#6687a8"></span>
      <small>${escapeHtml(item.label)}</small>
    </div>`;
  }).join('');
}

function renderVehicleStatusFilter() {
  const select = q('vehicleStatusFilter');
  const current = select.value;
  const statuses = [...new Set(data.vehicles.map((vehicle) => vehicle.status))];
  select.innerHTML = '<option value="all">Todos los estados</option>' + statuses.map((status) => `<option>${escapeHtml(status)}</option>`).join('');
  select.value = statuses.includes(current) ? current : 'all';
}

function renderVehicles() {
  const status = q('vehicleStatusFilter').value;
  const term = q('vehicleSearch').value;
  const rows = data.vehicles.filter((vehicle) =>
    (status === 'all' || vehicle.status === status)
    && includesTerm([vehicle.plate, vehicle.brand, vehicle.model, vehicle.type, vehicle.ownership, vehicle.city, vehicle.status], term)
  );
  q('vehiclesTable').innerHTML = rows.length
    ? rows.map((vehicle) => `<tr>
      <td><div class="vehicle-cell"><div class="vehicle-thumb">${iconToken('vehicle', 'UN', 'tiny-chip')}</div><div><strong>${escapeHtml(vehicle.plate)}</strong><span>${escapeHtml(`${vehicle.brand} ${vehicle.model}`)}</span></div></div></td>
      <td>${escapeHtml(vehicle.type)}</td><td>${escapeHtml(vehicle.ownership)}${vehicle.rent ? `<br><small>${money(vehicle.rent)}/mes</small>` : ''}</td>
      <td>${escapeHtml(vehicle.city)}</td><td>${Number(vehicle.odometer).toLocaleString('es-PE')} km</td>
      <td><span class="status ${statusClass(vehicle.status)}">${escapeHtml(vehicle.status)}</span></td>
      <td><div class="row-actions"><button class="row-action" type="button" data-detail-type="vehicle" data-detail-id="${vehicle.id}">Ver ficha</button><button class="row-action danger-action" type="button" data-delete-vehicle="${vehicle.id}">Eliminar</button></div></td>
    </tr>`).join('')
    : '<tr><td colspan="7"><div class="empty-state"><strong>No se encontraron unidades</strong>Prueba con otro criterio de búsqueda.</div></td></tr>';
}

function renderDrivers() {
  const term = q('driverSearch').value;
  const rows = data.drivers.filter((driver) => includesTerm([driver.name, driver.dni, driver.license, driver.category, driver.team, driver.zone, driver.phone, driver.status], term));
  q('driversGrid').innerHTML = rows.length
    ? rows.map((driver) => `<article class="driver-card">
      <div class="driver-top"><div class="driver-avatar">${initials(driver.name)}</div><div><h3>${escapeHtml(driver.name)}</h3><p>DNI ${escapeHtml(driver.dni)}</p></div></div>
      <div class="driver-info"><div class="info-box"><span>Licencia</span><strong>${escapeHtml(driver.license)} / ${escapeHtml(driver.category)}</strong></div><div class="info-box"><span>Vencimiento</span><strong>${formatDate(driver.expiry)}</strong></div><div class="info-box"><span>Team</span><strong>${escapeHtml(driver.team)}</strong></div><div class="info-box"><span>Zonal</span><strong>${escapeHtml(driver.zone)}</strong></div></div>
      <div class="driver-footer"><span class="status ${driver.status === 'Habilitado' ? 'valid' : 'warning'}">${escapeHtml(driver.status)}</span><div class="driver-card-actions"><button class="row-action" type="button" data-edit-driver="${driver.id}">Editar</button><button class="text-button" type="button" data-detail-type="driver" data-detail-id="${driver.id}">Ver ficha</button></div></div>
    </article>`).join('')
    : '<div class="empty-state"><strong>Sin resultados</strong>No se encontraron conductores.</div>';
}

function renderAssignments() {
  const term = q('assignmentSearch').value;
  const status = q('assignmentStatusFilter').value;
  const rows = data.assignments.filter((assignment) => {
    const vehicle = vehicleById(assignment.vehicleId);
    const driver = driverById(assignment.driverId);
    return (status === 'all' || assignment.status === status)
      && includesTerm([vehicle?.plate, vehicle?.brand, driver?.name, driver?.dni, assignment.team, assignment.zone, assignment.location, assignment.status], term);
  });
  q('assignmentsTable').innerHTML = rows.length
    ? rows.map((assignment) => {
      const vehicle = vehicleById(assignment.vehicleId);
      const driver = driverById(assignment.driverId);
      return `<tr><td><strong>${escapeHtml(vehicle?.plate || 'Sin placa')}</strong><br><small>${escapeHtml(`${vehicle?.brand || ''} ${vehicle?.model || ''}`.trim())}</small></td><td>${escapeHtml(assignmentDriverName(assignment))}</td><td>${escapeHtml(assignmentDriverDni(assignment))}</td><td>${escapeHtml(assignment.team)}<br><small>${escapeHtml(assignment.zone)}</small></td><td>${formatDate(assignment.date)}<br><small>${escapeHtml(assignment.location)}</small></td><td>${Number(assignment.odometer).toLocaleString('es-PE')} km</td><td><select class="status-editor" data-status-type="assignment" data-status-id="${assignment.id}">${['Activa','Pendiente','Cerrada'].map((option) => `<option ${assignment.status === option ? 'selected' : ''}>${option}</option>`).join('')}</select></td><td><button class="row-action" type="button" data-detail-type="assignment" data-detail-id="${assignment.id}">Ver historial</button></td></tr>`;
    }).join('')
    : '<tr><td colspan="8"><div class="empty-state"><strong>Sin resultados</strong>No hay asignaciones con esos filtros.</div></td></tr>';
}

function renderDocuments() {
  const term = q('documentSearch').value;
  const rows = data.documents.filter((documentItem) => {
    const vehicle = vehicleById(documentItem.vehicleId);
    return includesTerm([vehicle?.plate, vehicle?.brand, documentItem.type, documentItem.file, documentItem.status], term);
  });
  q('documentsTable').innerHTML = rows.length
    ? rows.map((documentItem) => {
      const vehicle = vehicleById(documentItem.vehicleId);
      return `<tr><td><strong>${escapeHtml(vehicle?.plate || 'Sin placa')}</strong><br><small>${escapeHtml(`${vehicle?.brand || ''} ${vehicle?.model || ''}`.trim())}</small></td><td>${escapeHtml(documentItem.type)}</td><td>${formatDate(documentItem.issued)}</td><td>${formatDate(documentItem.expiry)}</td><td><div class="action-stack"><span class="file-pill">${escapeHtml(documentItem.file || 'Sin archivo')}</span>${fileButton(documentItem, `${documentItem.type} / ${vehicle?.plate || 'Unidad'}`)}</div></td><td><span class="status ${statusClass(documentItem.status)}">${escapeHtml(documentItem.status)}</span></td><td><button class="row-action" type="button" data-detail-type="document" data-detail-id="${documentItem.id}">Ver detalle</button></td></tr>`;
    }).join('')
    : '<tr><td colspan="7"><div class="empty-state"><strong>Sin resultados</strong>No se encontraron documentos.</div></td></tr>';
  const groups = ['Vigente', 'Por vencer', 'Vencido'];
  const cards = [['Total', data.documents.length], ...groups.map((group) => [group, data.documents.filter((item) => item.status === group).length])];
  q('documentStats').innerHTML = cards.map(([label, value]) => `<div class="strip-card"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderIncidents() {
  const term = q('incidentSearch').value;
  const columns = [['Abierto', 'Reportados'], ['En proceso', 'En atención'], ['Cerrado', 'Cerrados']];
  q('incidentKanban').innerHTML = columns.map(([status, title]) => {
    const items = data.incidents.filter((incident) => {
      const vehicle = vehicleById(incident.vehicleId);
      return incident.status === status && includesTerm([vehicle?.plate, vehicle?.city, incident.type, incident.severity, incident.description, incident.status], term);
    });
    return `<section class="kanban-column"><div class="kanban-title"><h3>${title}</h3><span>${items.length}</span></div>${items.map((incident) => {
      const vehicle = vehicleById(incident.vehicleId);
      const responsible = incidentResponsible(incident);
      return `<article class="incident-card"><span class="tag ${slug(incident.severity)}">${escapeHtml(incident.severity)}</span><h4>${escapeHtml(incident.type)} / ${escapeHtml(vehicle?.plate || 'Sin placa')}</h4><p>${escapeHtml(incident.description)}</p>${responsible ? `<div class="incident-responsible-line"><span>Responsable</span><strong>${escapeHtml(responsible.name)}</strong></div>` : `<div class="incident-responsible-line no-assignment"><span>Responsable</span><strong>Sin asignación registrada en esa fecha</strong></div>`}<div class="incident-meta"><span>${formatDate(incident.date)}</span><span>${escapeHtml(vehicle?.city || '')}</span></div><div class="incident-actions"><select class="status-editor" data-status-type="incident" data-status-id="${incident.id}">${['Abierto','En proceso','Cerrado'].map((option) => `<option ${incident.status === option ? 'selected' : ''}>${option}</option>`).join('')}</select><div class="action-stack"><button class="row-action" type="button" data-detail-type="incident" data-detail-id="${incident.id}">Ver detalle</button>${incident.fileStorageKey ? `<button class="row-action" type="button" data-open-file="${escapeHtml(incident.fileStorageKey)}" data-file-title="Evidencia del incidente">Evidencia</button>` : ''}</div></div></article>`;
    }).join('') || '<div class="empty-state">Sin registros</div>'}</section>`;
  }).join('');
}

function renderMaintenance() {
  const term = q('maintenanceSearch').value;
  const rows = data.maintenance.filter((maintenance) => {
    const vehicle = vehicleById(maintenance.vehicleId);
    return includesTerm([vehicle?.plate, vehicle?.brand, maintenance.type, maintenance.workshop, maintenance.description, maintenance.status], term);
  });
  q('maintenanceTable').innerHTML = rows.length
    ? rows.map((maintenance) => {
      const vehicle = vehicleById(maintenance.vehicleId);
      return `<tr><td><strong>${escapeHtml(vehicle?.plate || 'Sin placa')}</strong><br><small>${escapeHtml(`${vehicle?.brand || ''} ${vehicle?.model || ''}`.trim())}</small></td><td>${escapeHtml(maintenance.type)}<br><small>${escapeHtml(maintenance.description)}</small></td><td>${escapeHtml(maintenance.workshop)}</td><td>${formatDate(maintenance.entry)}</td><td>${formatDate(maintenance.exit)}</td><td>${money(maintenance.cost)}</td><td><select class="status-editor" data-status-type="maintenance" data-status-id="${maintenance.id}">${['Programado','En proceso','Completado','Cancelado'].map((option) => `<option ${maintenance.status === option ? 'selected' : ''}>${option}</option>`).join('')}</select></td><td><div class="action-stack"><button class="row-action" type="button" data-detail-type="maintenance" data-detail-id="${maintenance.id}">Ver</button>${maintenance.fileStorageKey ? `<button class="row-action" type="button" data-open-file="${escapeHtml(maintenance.fileStorageKey)}" data-file-title="Evidencia de mantenimiento">Archivo</button>` : ''}</div></td></tr>`;
    }).join('')
    : '<tr><td colspan="8"><div class="empty-state"><strong>Sin resultados</strong>No se encontraron mantenimientos.</div></td></tr>';
  const upcoming = data.maintenance.filter((item) => ['Programado','En proceso'].includes(item.status)).sort((a,b) => String(a.entry).localeCompare(String(b.entry))).slice(0,3);
  q('maintenanceSchedule').innerHTML = upcoming.length ? upcoming.map((item) => { const vehicle = vehicleById(item.vehicleId); const date = new Date(`${item.entry}T12:00:00`); return `<div class="timeline-item"><div class="timeline-date">${String(date.getDate()).padStart(2,'0')}<small>${date.toLocaleDateString('es-PE',{month:'short'}).toUpperCase()}</small></div><div><h4>${escapeHtml(item.type)} / ${escapeHtml(vehicle?.plate || 'Unidad')}</h4><p>${escapeHtml(item.workshop)} · ${escapeHtml(item.status)}</p></div></div>`; }).join('') : '<div class="empty-state">No hay servicios programados.</div>';
}

function renderReturns() {
  const term = q('returnSearch').value;
  const rows = data.returns.filter((returnItem) => {
    const assignment = assignmentById(returnItem.assignmentId);
    const vehicle = vehicleById(assignment?.vehicleId);
    const driver = driverById(assignment?.driverId);
    return includesTerm([vehicle?.plate, driver?.name, driver?.dni, assignment?.team, assignment?.zone, returnItem.location, returnItem.status], term);
  });
  q('returnsList').innerHTML = rows.length
    ? rows.map((returnItem) => {
      const assignment = assignmentById(returnItem.assignmentId);
      const vehicle = vehicleById(assignment?.vehicleId);
      const driver = driverById(assignment?.driverId);
      return `<article class="return-item"><div class="return-icon">${iconToken('return', 'DEV', 'tiny-chip')}</div><div><h4>${escapeHtml(vehicle?.plate || 'Sin placa')} / ${escapeHtml(assignmentDriverName(assignment))}</h4><p>${escapeHtml(assignment?.team || '')} / ${escapeHtml(assignment?.zone || '')}</p></div><div class="return-field"><span>Solicitud enviada</span><strong>${formatDate(returnItem.requestDate)}</strong></div><div class="return-field"><span>Fecha límite</span><strong>${formatDate(returnItem.dueDate)}</strong></div><select class="status-editor" data-status-type="return" data-status-id="${returnItem.id}">${['Pendiente','Correo enviado','Confirmado','Reprogramado','Devuelto'].map((option) => `<option ${returnItem.status === option ? 'selected' : ''}>${option}</option>`).join('')}</select><div class="action-stack"><button class="row-action" type="button" data-detail-type="return" data-detail-id="${returnItem.id}">Ver detalle</button>${returnItem.fileStorageKeys?.length ? `<button class="row-action" type="button" data-open-file="${escapeHtml(returnItem.fileStorageKeys[0])}" data-file-title="Evidencia de devolución">Ver foto</button>` : ''}</div></article>`;
    }).join('')
    : '<div class="empty-state"><strong>Sin resultados</strong>No se encontraron devoluciones.</div>';
}

function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateTime(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-PE', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

const PREUSE_CHECK_ITEMS = [
  { key: 'tires', field: 'check_tires', label: 'Llantas' },
  { key: 'lights', field: 'check_lights', label: 'Luces' },
  { key: 'mirrors', field: 'check_mirrors', label: 'Espejos' },
  { key: 'windshield', field: 'check_windshield', label: 'Parabrisas' },
  { key: 'plate', field: 'check_plate', label: 'Placa visible' },
  { key: 'body', field: 'check_body', label: 'Carrocería' },
  { key: 'fuel', field: 'check_fuel', label: 'Combustible' },
  { key: 'extinguisher', field: 'check_extinguisher', label: 'Extintor' },
  { key: 'firstaid', field: 'check_firstaid', label: 'Botiquín' },
  { key: 'documents', field: 'check_documents', label: 'Documentos' }
];

function normalizePreUseStatus(value) {
  const status = String(value || 'Conforme').trim();
  return status === 'Observado' ? 'No conforme' : status;
}

function isPreUseNonConforming(value) {
  return ['No conforme', 'Observado'].includes(String(value || ''));
}

function preUseCheckEntry(checks, key) {
  const raw = checks?.[key];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      status: normalizePreUseStatus(raw.status || 'Conforme'),
      detail: String(raw.detail || ''),
      photoPath: String(raw.photo_path || raw.photoPath || ''),
      photoName: String(raw.photo_name || raw.photoName || ''),
      photoMimeType: String(raw.photo_mime_type || raw.photoMimeType || '')
    };
  }
  return {
    status: normalizePreUseStatus(raw || 'Conforme'),
    detail: '', photoPath: '', photoName: '', photoMimeType: ''
  };
}

function preUseResultFromForm(form) {
  return PREUSE_CHECK_ITEMS.some((item) => isPreUseNonConforming(form.elements[item.field]?.value))
    ? 'Con observaciones'
    : 'Conforme';
}

function preUseGeneratedSummary(checks) {
  return PREUSE_CHECK_ITEMS
    .map((item) => {
      const entry = preUseCheckEntry(checks || {}, item.key);
      return isPreUseNonConforming(entry.status) && entry.detail ? `${item.label}: ${entry.detail}` : '';
    })
    .filter(Boolean)
    .join(' | ');
}

function preUseIssueDetailField(label, entry) {
  const status = normalizePreUseStatus(entry?.status || 'Conforme');
  const issue = isPreUseNonConforming(status);
  const detail = entry?.detail ? `<p>${escapeHtml(entry.detail)}</p>` : (issue ? '<p>Sin detalle registrado.</p>' : '');
  const photo = entry?.photoPath
    ? `<button class="row-action" type="button" data-preuse-photo="${escapeHtml(entry.photoPath)}" data-photo-name="${escapeHtml(entry.photoName || `Evidencia ${label}`)}" data-photo-title="Evidencia: ${escapeHtml(label)}">Ver evidencia</button>`
    : (issue ? '<p>Sin evidencia fotográfica.</p>' : '');
  return `<div class="detail-field preuse-detail-field ${issue ? 'issue' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(status)}</strong>${detail}${photo}</div>`;
}

function mapPreUseRow(row) {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    assignmentId: row.assignment_id,
    driverId: row.driver_id,
    plateSnapshot: row.plate_snapshot || '',
    vehicleLabelSnapshot: row.vehicle_label_snapshot || '',
    driverNameSnapshot: row.driver_name_snapshot || '',
    driverDniSnapshot: row.driver_dni_snapshot || '',
    teamSnapshot: row.team_snapshot || '',
    zoneSnapshot: row.zone_snapshot || '',
    assignmentStart: row.assignment_start || '',
    assignmentVerified: Boolean(row.assignment_verified),
    createdAt: row.check_at || row.created_at,
    localDate: row.local_date || String(row.check_at || '').slice(0, 10),
    odometer: Number(row.odometer || 0),
    result: row.result || 'Conforme',
    checks: row.checks || {},
    notes: row.notes || '',
    photoPath: row.photo_path || '',
    photoFile: row.photo_name || '',
    photoMimeType: row.photo_mime_type || '',
    source: row.source || 'personal-web',
    editedAt: row.edited_at || ''
  };
}

function subscribePreUseRealtime() {
  if (!supabaseClient || preUseRealtimeChannel) return;
  preUseRealtimeChannel = supabaseClient
    .channel('fleetguard-preuse-admin')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'preuse_checks' }, () => {
      loadPreUseChecksFromSupabase({ silent: true });
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') console.warn('Realtime de chequeos no disponible. Usa el botón Actualizar.');
    });
}

async function loadPreUseChecksFromSupabase({ silent = false } = {}) {
  if (!supabaseClient) return;
  try {
    const { data: rows, error } = await supabaseClient
      .from('preuse_checks')
      .select('*')
      .order('check_at', { ascending: false });
    if (error) throw error;
    data.preUseChecks = (rows || []).map(mapPreUseRow);
    saveData();
    renderPreUseChecks();
    if (!silent) toast('Chequeos actualizados desde Supabase.');
  } catch (error) {
    console.warn('No se pudieron cargar los chequeos pre-uso:', error);
    if (!silent) toast('No se pudieron cargar los chequeos. Ejecuta primero 07_preuse_checks.sql.');
  }
}

function renderPreUseChecks() {
  const term = q('preUseSearch')?.value || '';
  const checks = [...data.preUseChecks]
    .filter((check) => includesTerm([
      check.plateSnapshot, check.vehicleLabelSnapshot, check.driverNameSnapshot,
      check.driverDniSnapshot, check.teamSnapshot, check.zoneSnapshot, check.result, check.notes, JSON.stringify(check.checks || {})
    ], term))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const today = localDateValue();
  const todayChecks = data.preUseChecks.filter((item) => String(item.localDate || '').slice(0, 10) === today);
  const observed = todayChecks.filter((item) => item.result === 'Con observaciones').length;
  const conforming = todayChecks.filter((item) => item.result === 'Conforme').length;
  q('preUseSummary').innerHTML = [
    ['Chequeos de hoy', todayChecks.length, 'Registros'],
    ['Conformes', conforming, 'Sin observaciones'],
    ['Con observaciones', observed, 'Revisar']
  ].map(([label, value, meta]) => `<article class="preuse-summary-card"><span>${escapeHtml(label)}</span><strong>${value}</strong><small>${escapeHtml(meta)}</small></article>`).join('');

  q('preUseTable').innerHTML = checks.length
    ? checks.map((check) => `<tr>
      <td><strong>${escapeHtml(formatDateTime(check.createdAt))}</strong>${check.editedAt ? '<br><small>Editado por administración</small>' : ''}</td>
      <td><strong>${escapeHtml(check.plateSnapshot || 'Sin placa')}</strong><br><small>${escapeHtml(check.vehicleLabelSnapshot || '')}</small></td>
      <td>${escapeHtml(check.driverNameSnapshot || 'Sin conductor')}<br><small>DNI ${escapeHtml(check.driverDniSnapshot || 'Sin DNI')}</small></td>
      <td>${Number(check.odometer || 0).toLocaleString('es-PE')} km</td>
      <td><span class="status ${statusClass(check.result)}">${escapeHtml(check.result)}</span></td>
      <td><span class="status ${check.assignmentVerified ? 'valid' : 'warning'}">${check.assignmentVerified ? 'Asignación validada' : 'Revisar'}</span></td>
      <td>${check.photoPath ? `<button class="row-action" type="button" data-preuse-photo="${escapeHtml(check.photoPath)}" data-photo-name="${escapeHtml(check.photoFile || 'Foto pre-uso')}" data-photo-title="Foto panorámica pre-uso">Ver foto</button>` : '<span class="file-pill">Sin foto</span>'}</td>
      <td><div class="row-actions"><button class="row-action" type="button" data-detail-type="preuse" data-detail-id="${escapeHtml(check.id)}">Ver detalle</button><button class="row-action" type="button" data-edit-preuse="${escapeHtml(check.id)}">Editar</button></div></td>
    </tr>`).join('')
    : '<tr><td colspan="8"><div class="empty-state"><strong>Sin chequeos registrados</strong>Los registros enviados por el personal aparecerán aquí.</div></td></tr>';
}


function toDatetimeLocal(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function syncPreUseEditIssueField(item) {
  const form = q('preUseEditForm');
  const select = form?.elements[item.field];
  if (!form || !select) return;
  const panel = form.querySelector(`[data-edit-issue-fields="${item.key}"]`);
  const wrapper = form.querySelector(`[data-edit-check-item="${item.key}"]`);
  const detail = form.elements[`issue_${item.key}_detail`];
  const photo = form.elements[`issue_${item.key}_photo`];
  const active = isPreUseNonConforming(select.value);
  if (panel) panel.hidden = !active;
  wrapper?.classList.toggle('has-issue', active);
  if (detail) detail.required = active;
  if (photo) photo.required = active && !photo.dataset.existingPath;
}

function updatePreUseEditResult() {
  const form = q('preUseEditForm');
  if (!form) return;
  PREUSE_CHECK_ITEMS.forEach(syncPreUseEditIssueField);
  const result = preUseResultFromForm(form);
  q('preUseEditResult').value = result;
  q('preUseEditNotes').required = false;
}

function editPreUseCheck(id) {
  const item = data.preUseChecks.find((check) => String(check.id) === String(id));
  if (!item) { toast('No se encontró el chequeo.'); return; }
  const form = q('preUseEditForm');
  form.reset();
  q('preUseEditId').value = item.id;
  q('preUseEditAt').value = toDatetimeLocal(item.createdAt);
  q('preUseEditPlate').value = item.plateSnapshot || '';
  q('preUseEditDriver').value = item.driverNameSnapshot || '';
  q('preUseEditDni').value = item.driverDniSnapshot || '';
  q('preUseEditOdometer').value = Number(item.odometer || 0);
  q('preUseEditNotes').value = item.notes && item.notes !== preUseGeneratedSummary(item.checks || {}) ? item.notes : '';

  PREUSE_CHECK_ITEMS.forEach((checkItem) => {
    const entry = preUseCheckEntry(item.checks || {}, checkItem.key);
    const select = form.elements[checkItem.field];
    const detail = form.elements[`issue_${checkItem.key}_detail`];
    const photo = form.elements[`issue_${checkItem.key}_photo`];
    const existingButton = form.querySelector(`[data-existing-issue-photo="${checkItem.key}"]`);
    if (select) select.value = entry.status;
    if (detail) detail.value = entry.detail || '';
    if (photo) {
      photo.value = '';
      photo.dataset.existingPath = entry.photoPath || '';
      photo.dataset.existingName = entry.photoName || '';
      photo.dataset.existingMime = entry.photoMimeType || '';
    }
    if (existingButton) {
      existingButton.hidden = !entry.photoPath;
      existingButton.dataset.preusePhoto = entry.photoPath || '';
      existingButton.dataset.photoName = entry.photoName || `Evidencia ${checkItem.label}`;
      existingButton.dataset.photoTitle = `Evidencia: ${checkItem.label}`;
    }
  });

  updatePreUseEditResult();
  closeModal(q('detailModal'));
  openModal('preUseEditModal');
}

async function openPreUseRemotePhoto(path, name = 'Foto pre-uso', title = 'Foto panorámica pre-uso') {
  if (!supabaseClient || !path) return;
  try {
    const { data: signed, error } = await supabaseClient.storage
      .from('preuse-evidence')
      .createSignedUrl(path, 600);
    if (error) throw error;
    const url = signed?.signedUrl;
    if (!url) throw new Error('No se pudo generar el enlace de la fotografía.');
    q('fileViewerTitle').textContent = title || 'Evidencia pre-uso';
    q('fileViewerName').textContent = name || 'Foto pre-uso';
    q('fileDownloadButton').href = url;
    q('fileDownloadButton').download = name || 'foto-preuso';
    q('fileViewerContent').innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(title || 'Evidencia del chequeo pre-uso')}">`;
    openModal('fileViewerModal');
  } catch (error) {
    console.error(error);
    toast('No se pudo abrir la fotografía desde Supabase.');
  }
}

async function uploadAdminPreUsePhoto(file, plate, dni, category = 'panoramica') {
  if (!file) return '';
  if (file.size > 15 * 1024 * 1024) throw new Error('La fotografía supera el límite de 15 MB.');
  const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeCategory = String(category || 'evidencia').replace(/[^a-z0-9-]/gi, '').toLowerCase();
  const safePlate = String(plate || 'UNIDAD').replace(/[^A-Z0-9-]/gi, '').toUpperCase();
  const safeDni = String(dni || 'DNI').replace(/\D/g, '');
  const path = `admin/${localDateValue()}/${safePlate}-${safeDni}/${safeCategory}-${uuid}.${ext}`;
  const { error } = await supabaseClient.storage.from('preuse-evidence').upload(path, file, {
    cacheControl: '3600', upsert: false, contentType: file.type || 'image/jpeg'
  });
  if (error) throw error;
  return path;
}

function populateSelects() {
  const availableVehicles = data.vehicles.filter((vehicle) => vehicle.status === 'Disponible');
  const vehicleOptions = data.vehicles.map((vehicle) => `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)} / ${escapeHtml(vehicle.brand)} ${escapeHtml(vehicle.model)}</option>`).join('');
  ['documentVehicleSelect', 'incidentVehicleSelect', 'maintenanceVehicleSelect'].forEach((id) => { q(id).innerHTML = vehicleOptions; });
  q('assignmentVehicleSelect').innerHTML = availableVehicles.length
    ? availableVehicles.map((vehicle) => `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)} / ${escapeHtml(vehicle.brand)} ${escapeHtml(vehicle.model)}</option>`).join('')
    : '<option value="">No hay unidades disponibles</option>';
  q('assignmentDriverSelect').innerHTML = data.drivers.filter((driver) => driver.status === 'Habilitado').map((driver) => `<option value="${driver.id}">${escapeHtml(driver.name)} / ${escapeHtml(driver.dni)}</option>`).join('');
  const activeAssignments = data.assignments.filter((assignment) => ['Activa', 'Pendiente'].includes(assignment.status));
  q('returnAssignmentSelect').innerHTML = activeAssignments.length
    ? activeAssignments.map((assignment) => {
      const vehicle = vehicleById(assignment.vehicleId);
      const driver = driverById(assignment.driverId);
      return `<option value="${assignment.id}">${escapeHtml(vehicle?.plate || 'Sin placa')} / ${escapeHtml(assignmentDriverName(assignment))}</option>`;
    }).join('')
    : '<option value="">No hay asignaciones activas</option>';

  syncAssignmentDefaults();
}

function renderAll() {
  renderStats();
  renderFleetDistribution();
  renderDocumentAlerts();
  renderRecentAssignments();
  renderExpenseChart();
  renderVehicleStatusFilter();
  renderVehicles();
  renderDrivers();
  renderAssignments();
  renderPreUseChecks();
  renderDocuments();
  renderIncidents();
  renderMaintenance();
  renderReturns();
  renderNotifications();
  populateSelects();
}

function openModal(id) {
  const modal = q(id);
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  qa('input[type="date"]', modal).forEach((input) => {
    if (!input.value) input.value = new Date().toISOString().slice(0, 10);
  });
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (modal.id === 'fileViewerModal' && modal.dataset.objectUrl) {
    URL.revokeObjectURL(modal.dataset.objectUrl);
    delete modal.dataset.objectUrl;
    q('fileViewerContent').innerHTML = '';
  }
  if (!document.querySelector('.modal.open')) document.body.style.overflow = '';
}

function toast(message) {
  const element = q('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2800);
}

function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function setVehicleStatus(vehicleId, status) { const vehicle = vehicleById(vehicleId); if (vehicle) vehicle.status = status; }

function detailField(label, value) {
  return `<div class="detail-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 'Sin información')}</strong></div>`;
}

function openDetail(type, id) {
  let title = 'Detalle';
  let eyebrow = 'Información registrada';
  let content = '';
  let actions = '';

  if (type === 'vehicle') {
    const item = vehicleById(id); if (!item) return;
    title = `Unidad ${item.plate}`; eyebrow = 'Ficha vehicular';
    content = [detailField('Marca y modelo', `${item.brand} ${item.model}`), detailField('Tipo', item.type), detailField('Propiedad', item.ownership), detailField('Ciudad actual', item.city), detailField('Odómetro', `${Number(item.odometer).toLocaleString('es-PE')} km`), detailField('Alquiler mensual', item.rent ? money(item.rent) : 'No aplica'), detailField('Estado', item.status), detailField('Observaciones', item.notes || 'Sin observaciones')].join('');
  } else if (type === 'driver') {
    const item = driverById(id); if (!item) return;
    title = item.name; eyebrow = 'Ficha del conductor';
    content = [detailField('DNI', item.dni), detailField('Licencia', item.license), detailField('Categoría', item.category), detailField('Vencimiento', formatDate(item.expiry)), detailField('Team', item.team), detailField('Zonal', item.zone), detailField('Teléfono', item.phone || 'Sin teléfono'), detailField('Estado', item.status)].join('');
    actions = `<div class="modal-actions"><button class="primary-button" type="button" data-edit-driver="${item.id}">Editar información</button></div>`;
  } else if (type === 'assignment') {
    const item = assignmentById(id); if (!item) return;
    const vehicle = vehicleById(item.vehicleId); const driver = driverById(item.driverId);
    title = `Asignación ${vehicle?.plate || ''}`; eyebrow = 'Historial de asignación';
    content = [detailField('Conductor', assignmentDriverName(item)), detailField('DNI', assignmentDriverDni(item)), detailField('Team', item.teamSnapshot || item.team), detailField('Zonal', item.zoneSnapshot || item.zone), detailField('Fecha de entrega', formatDate(item.date)), detailField('Lugar de entrega', item.location), detailField('Odómetro de salida', `${Number(item.odometer).toLocaleString('es-PE')} km`), detailField('Devolución estimada', formatDate(item.expectedReturn)), detailField('Estado', item.status), detailField('Observaciones', item.notes || 'Sin observaciones')].join('');
  } else if (type === 'preuse') {
    const item = data.preUseChecks.find((check) => String(check.id) === String(id)); if (!item) return;
    title = `Chequeo ${item.plateSnapshot || ''}`; eyebrow = 'Chequeo pre-uso vehicular';
    const checklistFields = PREUSE_CHECK_ITEMS.map((checkItem) =>
      preUseIssueDetailField(checkItem.label, preUseCheckEntry(item.checks || {}, checkItem.key))
    );
    content = [
      detailField('Fecha y hora', formatDateTime(item.createdAt)),
      detailField('Unidad', item.plateSnapshot || 'Sin placa'),
      detailField('Marca y modelo', item.vehicleLabelSnapshot || 'Sin información'),
      detailField('Conductor', item.driverNameSnapshot || 'Sin conductor'),
      detailField('DNI', item.driverDniSnapshot || 'Sin DNI'),
      detailField('Team / Zonal', `${item.teamSnapshot || 'Sin team'} / ${item.zoneSnapshot || 'Sin zonal'}`),
      detailField('Validación', item.assignmentVerified ? 'Asignación validada en Supabase' : 'Registro pendiente de validación'),
      detailField('Odómetro', `${Number(item.odometer || 0).toLocaleString('es-PE')} km`),
      detailField('Resultado', item.result || 'Conforme'),
      ...checklistFields,
      detailField('Observaciones generales', item.notes && item.notes !== preUseGeneratedSummary(item.checks || {}) ? item.notes : 'Sin observaciones adicionales')
    ].join('');
    actions = `<div class="modal-actions">${item.photoPath ? `<button class="secondary-button" type="button" data-preuse-photo="${escapeHtml(item.photoPath)}" data-photo-name="${escapeHtml(item.photoFile || 'Foto pre-uso')}" data-photo-title="Foto panorámica pre-uso">Visualizar foto panorámica</button>` : ''}<button class="primary-button" type="button" data-edit-preuse="${escapeHtml(item.id)}">Editar registro</button></div>`;
  } else if (type === 'document') {
    const item = data.documents.find((documentItem) => documentItem.id === Number(id)); if (!item) return;
    const vehicle = vehicleById(item.vehicleId);
    title = item.type; eyebrow = `Documento de ${vehicle?.plate || 'unidad'}`;
    content = [detailField('Unidad', vehicle?.plate), detailField('Emisión', formatDate(item.issued)), detailField('Vencimiento', formatDate(item.expiry)), detailField('Estado', item.status), detailField('Archivo registrado', item.file || 'Pendiente de carga')].join('');
    actions = item.fileStorageKey ? `<div class="modal-actions"><button class="primary-button" type="button" data-open-file="${escapeHtml(item.fileStorageKey)}" data-file-title="${escapeHtml(item.type)} / ${escapeHtml(vehicle?.plate || 'Unidad')}">Visualizar archivo</button></div>` : '<span class="inline-note">Este registro aún no tiene un archivo físico cargado en este navegador; adjunta uno nuevo para poder visualizarlo.</span>';
  } else if (type === 'incident') {
    const item = data.incidents.find((incident) => incident.id === Number(id)); if (!item) return;
    const vehicle = vehicleById(item.vehicleId);
    title = item.type; eyebrow = `Incidente / ${vehicle?.plate || 'unidad'}`;
    const responsible = incidentResponsible(item);
    const responsibleFields = responsible
      ? [
          detailField('Conductor responsable', responsible.name),
          detailField('DNI del responsable', responsible.dni),
          detailField('Team en la asignación', responsible.team || 'Sin información'),
          detailField('Zonal en la asignación', responsible.zone || 'Sin información'),
          detailField('Asignado desde', formatDate(responsible.start)),
          detailField('Asignación hasta', responsible.end ? formatDate(responsible.end) : 'Asignación aún abierta')
        ]
      : [detailField('Conductor responsable', 'Sin asignación registrada para esa fecha')];
    content = [detailField('Fecha', formatDate(item.date)), detailField('Gravedad', item.severity), detailField('Estado', item.status), detailField('Ubicación de la unidad', vehicle?.city), ...responsibleFields, detailField('Descripción', item.description), detailField('Solución', item.solution || 'Pendiente')].join('');
    actions = item.fileStorageKey ? `<div class="modal-actions"><button class="secondary-button" type="button" data-open-file="${escapeHtml(item.fileStorageKey)}" data-file-title="Evidencia del incidente">Visualizar evidencia</button></div>` : '';
  } else if (type === 'maintenance') {
    const item = data.maintenance.find((maintenance) => maintenance.id === Number(id)); if (!item) return;
    const vehicle = vehicleById(item.vehicleId);
    title = `${item.type} / ${vehicle?.plate || ''}`; eyebrow = 'Orden de mantenimiento';
    content = [detailField('Taller', item.workshop), detailField('Ingreso', formatDate(item.entry)), detailField('Salida estimada', formatDate(item.exit)), detailField('Costo', money(item.cost)), detailField('Estado', item.status), detailField('Trabajo', item.description)].join('');
    actions = item.fileStorageKey ? `<div class="modal-actions"><button class="secondary-button" type="button" data-open-file="${escapeHtml(item.fileStorageKey)}" data-file-title="Evidencia de mantenimiento">Visualizar archivo</button></div>` : '';
  } else if (type === 'return') {
    const item = data.returns.find((returnItem) => returnItem.id === Number(id)); if (!item) return;
    const assignment = assignmentById(item.assignmentId); const vehicle = vehicleById(assignment?.vehicleId); const driver = driverById(assignment?.driverId);
    title = `Devolución ${vehicle?.plate || ''}`; eyebrow = 'Cierre de asignación';
    content = [detailField('Conductor', assignmentDriverName(assignment)), detailField('Solicitud', formatDate(item.requestDate)), detailField('Fecha límite', formatDate(item.dueDate)), detailField('Lugar', item.location), detailField('Evidencia de correo', item.emailEvidence ? 'Registrada' : 'Pendiente'), detailField('Estado', item.status)].join('');
    actions = item.fileStorageKeys?.length ? `<div class="modal-actions"><button class="secondary-button" type="button" data-open-file="${escapeHtml(item.fileStorageKeys[0])}" data-file-title="Evidencia de devolución">Visualizar evidencia</button></div>` : '';
  }

  q('detailTitle').textContent = title;
  q('detailEyebrow').textContent = eyebrow;
  q('detailContent').innerHTML = `<div class="detail-grid">${content}</div>${actions}`;
  openModal('detailModal');
}

function buildSearchIndex() {
  const items = [];
  data.vehicles.forEach((item) => items.push({ view: 'vehicles', type: 'vehicle', id: item.id, code: 'UN', icon: 'vehicle', label: item.plate, meta: `${item.brand} ${item.model} / ${item.status}`, terms: [item.plate, item.brand, item.model, item.type, item.city, item.status] }));
  data.drivers.forEach((item) => items.push({ view: 'drivers', type: 'driver', id: item.id, code: 'CO', icon: 'driver', label: item.name, meta: `DNI ${item.dni} / ${item.team}`, terms: [item.name, item.dni, item.license, item.team, item.zone] }));
  data.assignments.forEach((item) => { const vehicle = vehicleById(item.vehicleId); const driver = driverById(item.driverId); items.push({ view: 'assignments', type: 'assignment', id: item.id, code: 'AS', icon: 'assignment', label: `${vehicle?.plate || 'Unidad'} / ${assignmentDriverName(item)}`, meta: `${item.teamSnapshot || item.team} / ${item.status}`, terms: [vehicle?.plate, assignmentDriverName(item), assignmentDriverDni(item), item.teamSnapshot || item.team, item.zoneSnapshot || item.zone, item.status] }); });
  data.preUseChecks.forEach((item) => items.push({ view: 'preuse', type: 'preuse', id: item.id, code: 'CK', icon: 'preuse', label: `${item.plateSnapshot || 'Unidad'} / ${item.driverNameSnapshot || 'Conductor'}`, meta: `${item.result || 'Conforme'} / ${formatDateTime(item.createdAt)}`, terms: [item.plateSnapshot, item.driverNameSnapshot, item.driverDniSnapshot, item.teamSnapshot, item.zoneSnapshot, item.result, item.notes] }));
  data.documents.forEach((item) => { const vehicle = vehicleById(item.vehicleId); items.push({ view: 'documents', type: 'document', id: item.id, code: 'DO', icon: 'document', label: `${item.type} / ${vehicle?.plate || 'Unidad'}`, meta: `${item.status} / ${formatDate(item.expiry)}`, terms: [vehicle?.plate, item.type, item.file, item.status] }); });
  data.incidents.forEach((item) => { const vehicle = vehicleById(item.vehicleId); items.push({ view: 'incidents', type: 'incident', id: item.id, code: 'IN', icon: 'incident', label: `${item.type} / ${vehicle?.plate || 'Unidad'}`, meta: `${item.severity} / ${item.status}`, terms: [vehicle?.plate, item.type, item.description, item.severity, item.status] }); });
  data.maintenance.forEach((item) => { const vehicle = vehicleById(item.vehicleId); items.push({ view: 'maintenance', type: 'maintenance', id: item.id, code: 'MA', icon: 'maintenance', label: `${item.type} / ${vehicle?.plate || 'Unidad'}`, meta: `${item.workshop} / ${item.status}`, terms: [vehicle?.plate, item.type, item.workshop, item.description, item.status] }); });
  return items;
}

function renderGlobalSearchResults() {
  const term = q('globalSearch').value.trim();
  const resultsBox = q('globalSearchResults');
  if (term.length < 2) {
    hideGlobalSearchResults();
    return;
  }
  const results = buildSearchIndex().filter((item) => includesTerm([...item.terms, item.label, item.meta], term)).slice(0, 10);
  resultsBox.innerHTML = results.length
    ? results.map((item) => `<button class="global-result-item" type="button" data-search-view="${item.view}" data-detail-type="${item.type}" data-detail-id="${item.id}"><span class="result-code">${iconToken(item.icon || typeIconName(item.type), item.code, 'tiny-chip')}</span><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.meta)}</small></span></button>`).join('')
    : '<div class="search-empty">No se encontraron coincidencias.</div>';
  resultsBox.hidden = false;
}

function hideGlobalSearchResults() {
  q('globalSearchResults').hidden = true;
}

function toggleNotificationPanel() {
  const panel = q('notificationPanel');
  const willOpen = panel.hidden;
  panel.hidden = !willOpen;
  q('notificationButton').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) hideGlobalSearchResults();
}

function closeNotificationPanel() {
  const panel = q('notificationPanel');
  if (!panel) return;
  panel.hidden = true;
  q('notificationButton')?.setAttribute('aria-expanded', 'false');
}

function syncAssignmentDefaults() {
  const driver = driverById(q('assignmentDriverSelect')?.value);
  const vehicle = vehicleById(q('assignmentVehicleSelect')?.value);
  const form = q('assignmentForm');
  if (driver && form) {
    form.elements.team.value = driver.team || '';
    form.elements.zone.value = driver.zone || '';
  }
  if (vehicle && form) form.elements.odometer.value = vehicle.odometer || 0;
}

function reportDefinition(name) {
  if (name === 'vehicles') return {
    title: 'Inventario de unidades',
    columns: ['Placa','Marca / modelo','Tipo','Propiedad','Ciudad','Odómetro','Estado'],
    rows: data.vehicles.map((item) => [item.plate, `${item.brand} ${item.model}`, item.type, item.ownership, item.city, `${Number(item.odometer).toLocaleString('es-PE')} km`, item.status])
  };
  if (name === 'assignments') return {
    title: 'Historial de asignaciones',
    columns: ['Placa','Conductor','DNI','Team','Zonal','Entrega','Estado'],
    rows: data.assignments.map((item) => { const vehicle=vehicleById(item.vehicleId); const driver=driverById(item.driverId); return [vehicle?.plate || '', assignmentDriverName(item), assignmentDriverDni(item), item.teamSnapshot || item.team, item.zoneSnapshot || item.zone, formatDate(item.date), item.status]; })
  };
  if (name === 'incidents') return {
    title: 'Incidentes registrados',
    columns: ['Placa','Tipo','Gravedad','Fecha','Estado','Descripción'],
    rows: data.incidents.map((item) => { const vehicle=vehicleById(item.vehicleId); return [vehicle?.plate || '', item.type, item.severity, formatDate(item.date), item.status, item.description]; })
  };
  if (name === 'documents') return {
    title: 'Vencimientos documentarios',
    columns: ['Placa','Documento','Emisión','Vencimiento','Estado','Archivo'],
    rows: data.documents.map((item) => { const vehicle=vehicleById(item.vehicleId); return [vehicle?.plate || '', item.type, formatDate(item.issued), formatDate(item.expiry), item.status, item.file || '']; })
  };
  return null;
}

function addPdfHeader(doc, title) {
  doc.setFillColor(18, 55, 91);
  doc.rect(0, 0, 210, 25, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(17);
  doc.setFont('helvetica', 'bold');
  doc.text('FleetGuard', 14, 11);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(title, 14, 18);
  doc.text(`Generado: ${new Date().toLocaleString('es-PE')}`, 196, 18, { align: 'right' });
  doc.setTextColor(27, 45, 63);
}

function addPdfPageNumbers(doc) {
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(`Página ${page} de ${pages}`, 196, 290, { align: 'right' });
  }
}

function downloadPdf(name = 'complete') {
  const JsPdf = window.jspdf?.jsPDF;
  if (!JsPdf) {
    toast('No se pudo cargar el generador PDF. Revisa la conexión a internet.');
    return;
  }
  const doc = new JsPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const fileDate = new Date().toISOString().slice(0, 10);
  if (name !== 'complete') {
    const report = reportDefinition(name);
    if (!report) return;
    addPdfHeader(doc, report.title);
    doc.autoTable({
      startY: 31,
      head: [report.columns],
      body: report.rows,
      styles: { fontSize: 7.8, cellPadding: 2.2, overflow: 'linebreak' },
      headStyles: { fillColor: [22, 75, 143], textColor: 255 },
      alternateRowStyles: { fillColor: [241, 245, 249] },
      margin: { left: 10, right: 10, bottom: 14 }
    });
    addPdfPageNumbers(doc);
    doc.save(`fleetguard_${name}_${fileDate}.pdf`);
    toast('Reporte PDF descargado correctamente.');
    return;
  }

  addPdfHeader(doc, 'Reporte general de gestión vehicular');
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Resumen ejecutivo', 14, 34);
  doc.autoTable({
    startY: 39,
    head: [['Indicador','Resultado']],
    body: [
      ['Total de unidades', String(data.vehicles.length)],
      ['Unidades asignadas', String(data.vehicles.filter((v) => v.status === 'Asignada').length)],
      ['Incidentes abiertos o en atención', String(data.incidents.filter((i) => i.status !== 'Cerrado').length)],
      ['Documentos vencidos o por vencer', String(data.documents.filter((d) => d.status !== 'Vigente').length)],
      ['Mantenimientos activos', String(data.maintenance.filter((m) => ['Programado','En proceso'].includes(m.status)).length)]
    ],
    theme: 'grid',
    headStyles: { fillColor: [22, 75, 143] },
    styles: { fontSize: 9 }
  });
  const sections = ['vehicles','assignments','incidents','documents'];
  sections.forEach((sectionName) => {
    const report = reportDefinition(sectionName);
    doc.addPage();
    addPdfHeader(doc, report.title);
    doc.autoTable({
      startY: 31,
      head: [report.columns],
      body: report.rows,
      styles: { fontSize: 7.4, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [22, 75, 143], textColor: 255 },
      alternateRowStyles: { fillColor: [241, 245, 249] },
      margin: { left: 9, right: 9, bottom: 14 }
    });
  });
  addPdfPageNumbers(doc);
  doc.save(`fleetguard_reporte_general_${fileDate}.pdf`);
  toast('Reporte general PDF descargado correctamente.');
}


function recalculateVehicleFromOperations(vehicleId) {
  const vehicle = vehicleById(vehicleId);
  if (!vehicle) return;
  const activeMaintenance = data.maintenance.some((item) => item.vehicleId === vehicleId && item.status === 'En proceso');
  const activeAssignment = data.assignments.find((item) => item.vehicleId === vehicleId && ['Activa','Pendiente'].includes(item.status));
  if (activeMaintenance) vehicle.status = 'Mantenimiento';
  else if (activeAssignment?.status === 'Pendiente') vehicle.status = 'Pendiente de devolución';
  else if (activeAssignment) vehicle.status = 'Asignada';
  else vehicle.status = 'Disponible';
}

function updateRecordStatus(type, id, status) {
  const numericId = Number(id);
  if (type === 'incident') {
    const item = data.incidents.find((record) => record.id === numericId);
    if (!item) return;
    item.status = status;
    item.closedAt = status === 'Cerrado' ? new Date().toISOString() : null;
  } else if (type === 'maintenance') {
    const item = data.maintenance.find((record) => record.id === numericId);
    if (!item) return;
    item.status = status;
    if (status === 'Completado' && !item.actualExit) item.actualExit = new Date().toISOString().slice(0,10);
    recalculateVehicleFromOperations(item.vehicleId);
  } else if (type === 'assignment') {
    const item = data.assignments.find((record) => record.id === numericId);
    if (!item) return;
    item.status = status;
    if (status === 'Cerrada' && !item.returnedAt) item.returnedAt = new Date().toISOString().slice(0,10);
    recalculateVehicleFromOperations(item.vehicleId);
  } else if (type === 'return') {
    const item = data.returns.find((record) => record.id === numericId);
    if (!item) return;
    item.status = status;
  }
  saveData();
  renderAll();
  toast(`Estado actualizado a ${status}.`);
}

function resetDriverFormForNew() {
  const form = q('driverForm');
  if (!form) return;
  form.reset();
  q('driverEditId').value = '';
  q('driverModalKicker').textContent = 'Nuevo registro';
  q('driverModalTitle').textContent = 'Registrar conductor';
  q('driverSubmitButton').textContent = 'Guardar conductor';
  form.elements.status.value = 'Habilitado';
}

function editDriver(id) {
  const driver = driverById(id);
  if (!driver) return;
  const form = q('driverForm');
  q('driverEditId').value = String(driver.id);
  form.elements.name.value = driver.name || '';
  form.elements.dni.value = driver.dni || '';
  form.elements.license.value = driver.license || '';
  form.elements.category.value = driver.category || '';
  form.elements.expiry.value = driver.expiry || '';
  form.elements.team.value = driver.team || '';
  form.elements.zone.value = driver.zone || '';
  form.elements.phone.value = driver.phone || '';
  form.elements.status.value = driver.status || 'Habilitado';
  q('driverModalKicker').textContent = 'Corrección de datos';
  q('driverModalTitle').textContent = 'Editar conductor';
  q('driverSubmitButton').textContent = 'Guardar cambios';
  closeModal(q('detailModal'));
  openModal('driverModal');
}

function updateIncidentResponsiblePreview() {
  const preview = q('incidentResponsiblePreview');
  const form = q('incidentForm');
  if (!preview || !form) return;
  const vehicleId = Number(form.elements.vehicle.value || 0);
  const date = form.elements.date.value;
  if (!vehicleId || !date) {
    preview.innerHTML = '<span class="preview-label">Responsable en la fecha del incidente</span><strong>Selecciona una unidad y una fecha.</strong>';
    preview.classList.remove('found');
    return;
  }
  const assignment = findAssignmentAtDate(vehicleId, date);
  if (!assignment) {
    preview.innerHTML = `<span class="preview-label">Responsable en la fecha del incidente</span><strong>Sin asignación registrada el ${escapeHtml(formatDate(date))}</strong><small>El incidente podrá registrarse, pero quedará sin conductor responsable asociado.</small>`;
    preview.classList.remove('found');
    return;
  }
  const end = assignmentEndDate(assignment);
  preview.innerHTML = `<span class="preview-label">Responsable en la fecha del incidente</span><strong>${escapeHtml(assignmentDriverName(assignment))}</strong><small>DNI ${escapeHtml(assignmentDriverDni(assignment))} · ${escapeHtml(assignment.teamSnapshot || assignment.team || 'Sin team')} · ${escapeHtml(assignment.zoneSnapshot || assignment.zone || 'Sin zonal')}<br>Asignación: ${escapeHtml(formatDate(assignment.date))} → ${escapeHtml(end ? formatDate(end) : 'actualmente activa')}</small>`;
  preview.classList.add('found');
}

// Navegación y acciones estáticas
qa('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
qa('[data-view-target]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.viewTarget)));
qa('[data-open-modal]').forEach((button) => button.addEventListener('click', () => { if (button.dataset.openModal === 'driverModal') resetDriverFormForNew(); openModal(button.dataset.openModal); }));
qa('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(button.closest('.modal'))));
q('menuToggle').addEventListener('click', () => q('sidebar').classList.toggle('open'));
q('notificationButton').addEventListener('click', toggleNotificationPanel);
q('closeNotificationPanel').addEventListener('click', closeNotificationPanel);

// Búsquedas y filtros
q('vehicleStatusFilter').addEventListener('change', renderVehicles);
q('vehicleSearch').addEventListener('input', renderVehicles);
q('driverSearch').addEventListener('input', renderDrivers);
q('assignmentSearch').addEventListener('input', renderAssignments);
q('assignmentStatusFilter').addEventListener('change', renderAssignments);
q('preUseSearch').addEventListener('input', renderPreUseChecks);
q('documentSearch').addEventListener('input', renderDocuments);
q('incidentSearch').addEventListener('input', renderIncidents);
q('maintenanceSearch').addEventListener('input', renderMaintenance);
q('returnSearch').addEventListener('input', renderReturns);
q('globalSearch').addEventListener('input', renderGlobalSearchResults);
q('globalSearch').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const firstResult = q('globalSearchResults').querySelector('.global-result-item');
    if (firstResult) { event.preventDefault(); firstResult.click(); }
  }
  if (event.key === 'Escape') hideGlobalSearchResults();
});
q('assignmentDriverSelect').addEventListener('change', syncAssignmentDefaults);
q('assignmentVehicleSelect').addEventListener('change', syncAssignmentDefaults);
q('incidentVehicleSelect').addEventListener('change', updateIncidentResponsiblePreview);
q('incidentDateInput').addEventListener('change', updateIncidentResponsiblePreview);
q('refreshPreUseButton').addEventListener('click', () => loadPreUseChecksFromSupabase());
q('preUseEditForm').addEventListener('change', (event) => {
  if (event.target.matches('.preuse-check-grid select')) {
    const item = PREUSE_CHECK_ITEMS.find((candidate) => candidate.field === event.target.name);
    if (item) syncPreUseEditIssueField(item);
    updatePreUseEditResult();
  }
});

// Delegación para botones generados dinámicamente
 document.addEventListener('click', (event) => {
  const editPreUseButton = event.target.closest('[data-edit-preuse]');
  if (editPreUseButton) {
    event.preventDefault();
    event.stopPropagation();
    editPreUseCheck(editPreUseButton.dataset.editPreuse);
    return;
  }

  const preUsePhotoButton = event.target.closest('[data-preuse-photo]');
  if (preUsePhotoButton) {
    event.preventDefault();
    event.stopPropagation();
    openPreUseRemotePhoto(preUsePhotoButton.dataset.preusePhoto, preUsePhotoButton.dataset.photoName || 'Foto pre-uso', preUsePhotoButton.dataset.photoTitle || 'Evidencia pre-uso');
    return;
  }

  const editDriverButton = event.target.closest('[data-edit-driver]');
  if (editDriverButton) {
    event.preventDefault();
    event.stopPropagation();
    editDriver(editDriverButton.dataset.editDriver);
    return;
  }

  const fileButtonElement = event.target.closest('[data-open-file]');
  if (fileButtonElement) {
    event.preventDefault();
    event.stopPropagation();
    openStoredFile(fileButtonElement.dataset.openFile, fileButtonElement.dataset.fileTitle || 'Archivo');
    return;
  }

  const detailButton = event.target.closest('[data-detail-type][data-detail-id]');
  if (detailButton) {
    const view = detailButton.dataset.searchView;
    if (view) switchView(view);
    openDetail(detailButton.dataset.detailType, detailButton.dataset.detailId);
    q('globalSearch').value = '';
    hideGlobalSearchResults();
    return;
  }

  const deleteButton = event.target.closest('[data-delete-vehicle]');
  if (deleteButton) {
    const id = Number(deleteButton.dataset.deleteVehicle);
    const vehicle = vehicleById(id);
    const linked = data.assignments.some((assignment) => assignment.vehicleId === id);
    if (linked) { toast('No se puede eliminar la unidad porque tiene historial.'); return; }
    if (!window.confirm(`¿Eliminar la unidad ${vehicle?.plate || ''}?`)) return;
    data.vehicles = data.vehicles.filter((item) => item.id !== id);
    saveData(); renderAll(); toast('Unidad eliminada.');
    return;
  }

  if (!event.target.closest('.global-search-wrap')) hideGlobalSearchResults();
  if (!event.target.closest('#notificationPanel') && !event.target.closest('#notificationButton')) closeNotificationPanel();
});

document.addEventListener('change', (event) => {
  const editor = event.target.closest('[data-status-type][data-status-id]');
  if (!editor) return;
  updateRecordStatus(editor.dataset.statusType, editor.dataset.statusId, editor.value);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    qa('.modal.open').forEach(closeModal);
    closeNotificationPanel();
    hideGlobalSearchResults();
  }
});

// Formularios operativos
q('vehicleForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = formObject(event.currentTarget);
  const plate = form.plate.toUpperCase().trim();
  if (data.vehicles.some((vehicle) => normalize(vehicle.plate) === normalize(plate))) { toast('La placa ya está registrada.'); return; }
  data.vehicles.push({ id: nextId(data.vehicles), plate, brand: form.brand.trim(), model: form.model.trim(), type: form.type, ownership: form.ownership, city: form.city.trim(), odometer: Number(form.odometer), rent: Number(form.rent || 0), status: 'Disponible', notes: form.notes });
  saveData(); renderAll(); event.currentTarget.reset(); closeModal(q('vehicleModal')); toast('Unidad registrada correctamente.');
});

q('driverForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = formObject(event.currentTarget);
  const editId = Number(form.editId || 0);
  const duplicateDni = data.drivers.some((driver) => driver.dni === form.dni && driver.id !== editId);
  const duplicateLicense = data.drivers.some((driver) => normalize(driver.license) === normalize(form.license) && driver.id !== editId);
  if (duplicateDni) { toast('El DNI ya está registrado en otro conductor.'); return; }
  if (duplicateLicense) { toast('La licencia ya está registrada en otro conductor.'); return; }

  const values = {
    name: form.name.trim(),
    dni: form.dni,
    license: form.license.trim(),
    category: form.category.trim(),
    expiry: form.expiry,
    team: form.team.trim(),
    zone: form.zone.trim(),
    phone: form.phone.trim(),
    status: form.status || 'Habilitado'
  };

  if (editId) {
    const driver = driverById(editId);
    if (!driver) { toast('No se encontró el conductor a editar.'); return; }
    Object.assign(driver, values);
    saveData(); renderAll(); resetDriverFormForNew(); closeModal(q('driverModal')); toast('Información del conductor actualizada.');
    return;
  }

  data.drivers.push({ id: nextId(data.drivers), ...values });
  saveData(); renderAll(); resetDriverFormForNew(); closeModal(q('driverModal')); toast('Conductor registrado correctamente.');
});

q('assignmentForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = formObject(event.currentTarget);
  const vehicleId = Number(form.vehicle);
  const vehicle = vehicleById(vehicleId);
  if (!vehicle) { toast('Selecciona una unidad disponible.'); return; }
  const hasActive = data.assignments.some((assignment) => assignment.vehicleId === vehicleId && ['Activa', 'Pendiente'].includes(assignment.status));
  if (hasActive || vehicle.status !== 'Disponible') { toast('Esta unidad no está disponible para una nueva asignación.'); return; }
  if (Number(form.odometer) < Number(vehicle.odometer)) { toast('El odómetro de salida no puede ser menor al actual.'); return; }
  const assignedDriver = driverById(form.driver);
  data.assignments.push({ id: nextId(data.assignments), vehicleId, driverId: Number(form.driver), driverNameSnapshot: assignedDriver?.name || '', driverDniSnapshot: assignedDriver?.dni || '', teamSnapshot: form.team.trim(), zoneSnapshot: form.zone.trim(), date: form.date, odometer: Number(form.odometer), team: form.team.trim(), zone: form.zone.trim(), location: form.location.trim(), expectedReturn: form.expectedReturn, status: 'Activa', notes: form.notes });
  setVehicleStatus(vehicleId, 'Asignada'); saveData(); renderAll(); event.currentTarget.reset(); closeModal(q('assignmentModal')); toast('Asignación creada correctamente.');
});

q('preUseEditForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!supabaseClient) { toast('No existe conexión con Supabase.'); return; }
  const formElement = event.currentTarget;
  const form = formObject(formElement);
  const id = String(form.id || '').trim();
  const existing = data.preUseChecks.find((check) => String(check.id) === id);
  if (!existing) { toast('No se encontró el registro a editar.'); return; }

  const dni = String(form.driverDni || '').replace(/\D/g, '').slice(0, 8);
  const plate = String(form.plate || '').trim().toUpperCase();
  const driverName = String(form.driverName || '').trim();
  const odometer = Number(form.odometer || 0);
  const result = preUseResultFromForm(formElement);
  const notes = String(form.notes || '').trim();
  if (dni.length !== 8) { toast('El DNI debe tener 8 dígitos.'); return; }
  if (!plate || !driverName) { toast('Completa placa y conductor.'); return; }

  for (const checkItem of PREUSE_CHECK_ITEMS) {
    const status = normalizePreUseStatus(formElement.elements[checkItem.field]?.value || 'Conforme');
    if (!isPreUseNonConforming(status)) continue;
    const detail = String(formElement.elements[`issue_${checkItem.key}_detail`]?.value || '').trim();
    const photoInput = formElement.elements[`issue_${checkItem.key}_photo`];
    if (!detail) { toast(`Completa el detalle de ${checkItem.label}.`); formElement.elements[`issue_${checkItem.key}_detail`]?.focus(); return; }
    if (!photoInput?.files?.[0] && !photoInput?.dataset?.existingPath) { toast(`Adjunta una evidencia fotográfica para ${checkItem.label}.`); return; }
  }

  const updatePayload = {
    plate_snapshot: plate,
    driver_name_snapshot: driverName,
    driver_dni_snapshot: dni,
    check_at: new Date(form.checkAt).toISOString(),
    local_date: String(form.checkAt || '').slice(0, 10),
    odometer,
    result,
    notes: notes || null,
    edited_at: new Date().toISOString()
  };

  let newPhotoPath = '';
  const uploadedIssuePaths = [];
  const removeAfterSuccess = [];
  const newPhoto = formElement.elements.photo.files[0];
  try {
    const checks = {};
    for (const checkItem of PREUSE_CHECK_ITEMS) {
      const status = normalizePreUseStatus(formElement.elements[checkItem.field]?.value || 'Conforme');
      const oldEntry = preUseCheckEntry(existing.checks || {}, checkItem.key);
      const issuePhotoInput = formElement.elements[`issue_${checkItem.key}_photo`];
      if (isPreUseNonConforming(status)) {
        const detail = String(formElement.elements[`issue_${checkItem.key}_detail`]?.value || '').trim();
        let photoPath = issuePhotoInput?.dataset?.existingPath || oldEntry.photoPath || '';
        let photoName = issuePhotoInput?.dataset?.existingName || oldEntry.photoName || '';
        let photoMimeType = issuePhotoInput?.dataset?.existingMime || oldEntry.photoMimeType || '';
        const replacement = issuePhotoInput?.files?.[0];
        if (replacement) {
          const uploaded = await uploadAdminPreUsePhoto(replacement, plate, dni, checkItem.key);
          uploadedIssuePaths.push(uploaded);
          if (photoPath) removeAfterSuccess.push(photoPath);
          photoPath = uploaded;
          photoName = replacement.name;
          photoMimeType = replacement.type || 'image/jpeg';
        }
        checks[checkItem.key] = {
          status: 'No conforme', detail,
          photo_path: photoPath, photo_name: photoName, photo_mime_type: photoMimeType
        };
      } else {
        if (oldEntry.photoPath) removeAfterSuccess.push(oldEntry.photoPath);
        checks[checkItem.key] = { status };
      }
    }
    updatePayload.checks = checks;

    const { data: resolved, error: resolveError } = await supabaseClient.rpc('resolve_preuse_assignment', { p_dni: dni, p_plate: plate });
    if (resolveError) throw resolveError;
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (match) {
      Object.assign(updatePayload, {
        vehicle_id: match.vehicle_id,
        assignment_id: match.assignment_id,
        driver_id: match.driver_id,
        plate_snapshot: match.plate || plate,
        vehicle_label_snapshot: match.vehicle_label || existing.vehicleLabelSnapshot || null,
        driver_name_snapshot: match.driver_name || driverName,
        driver_dni_snapshot: match.driver_dni || dni,
        team_snapshot: match.team || null,
        zone_snapshot: match.zone || null,
        assignment_start: match.assignment_start || null,
        assignment_verified: true
      });
    } else {
      Object.assign(updatePayload, {
        vehicle_id: null, assignment_id: null, driver_id: null,
        assignment_verified: false,
        team_snapshot: null, zone_snapshot: null, assignment_start: null
      });
    }

    if (newPhoto) {
      newPhotoPath = await uploadAdminPreUsePhoto(newPhoto, plate, dni, 'panoramica');
      Object.assign(updatePayload, {
        photo_path: newPhotoPath,
        photo_name: newPhoto.name,
        photo_mime_type: newPhoto.type || 'image/jpeg'
      });
    }

    const { error } = await supabaseClient.from('preuse_checks').update(updatePayload).eq('id', id);
    if (error) throw error;

    if (newPhotoPath && existing.photoPath) removeAfterSuccess.push(existing.photoPath);
    const uniqueOldPaths = [...new Set(removeAfterSuccess.filter(Boolean).filter((path) => path !== newPhotoPath && !uploadedIssuePaths.includes(path)))];
    if (uniqueOldPaths.length) supabaseClient.storage.from('preuse-evidence').remove(uniqueOldPaths).catch(() => {});

    closeModal(q('preUseEditModal'));
    await loadPreUseChecksFromSupabase({ silent: true });
    toast('Chequeo actualizado correctamente.');
  } catch (error) {
    console.error(error);
    const cleanup = [newPhotoPath, ...uploadedIssuePaths].filter(Boolean);
    if (cleanup.length) {
      try { await supabaseClient.storage.from('preuse-evidence').remove(cleanup); } catch {}
    }
    toast(error.message || 'No se pudo actualizar el chequeo.');
  }
});

q('documentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = formObject(event.currentTarget);
  const file = event.currentTarget.elements.file.files[0];
  const today = new Date();
  const expiry = new Date(`${form.expiry}T12:00:00`);
  const days = Math.ceil((expiry - today) / 86400000);
  const status = days < 0 ? 'Vencido' : days <= 30 ? 'Por vencer' : 'Vigente';
  const id = nextId(data.documents);
  try {
    const fileStorageKey = file ? await saveLocalFile(file, `document-${id}`) : null;
    data.documents.push({ id, vehicleId: Number(form.vehicle), type: form.type, issued: form.issued, expiry: form.expiry, file: file?.name || 'Sin archivo', mimeType: file?.type || '', fileStorageKey, status });
    saveData(); renderAll(); event.currentTarget.reset(); closeModal(q('documentModal')); toast('Documento registrado correctamente.');
  } catch (error) { toast(error.message || 'No se pudo guardar el documento.'); }
});

q('incidentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = formObject(event.currentTarget);
  const file = event.currentTarget.elements.file.files[0];
  const id = nextId(data.incidents);
  try {
    const fileStorageKey = file ? await saveLocalFile(file, `incident-${id}`) : null;
    const vehicleId = Number(form.vehicle);
    const assignment = findAssignmentAtDate(vehicleId, form.date);
    data.incidents.push({
      id,
      vehicleId,
      assignmentId: assignment?.id || null,
      responsibleDriverId: assignment?.driverId || null,
      responsibleName: assignment ? assignmentDriverName(assignment) : '',
      responsibleDni: assignment ? assignmentDriverDni(assignment) : '',
      responsibleTeam: assignment ? (assignment.teamSnapshot || assignment.team || '') : '',
      responsibleZone: assignment ? (assignment.zoneSnapshot || assignment.zone || '') : '',
      assignmentStart: assignment?.date || '',
      assignmentEnd: assignment ? (assignmentEndDate(assignment) || '') : '',
      type: form.type,
      date: form.date,
      severity: form.severity,
      description: form.description.trim(),
      status: 'Abierto',
      evidenceFile: file?.name || '',
      fileStorageKey
    });
    saveData(); renderAll(); event.currentTarget.reset(); updateIncidentResponsiblePreview(); closeModal(q('incidentModal')); toast(assignment ? `Incidente registrado. Responsable: ${assignmentDriverName(assignment)}.` : 'Incidente registrado sin asignación activa para esa fecha.');
  } catch (error) { toast(error.message || 'No se pudo guardar el incidente.'); }
});

q('maintenanceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = formObject(event.currentTarget);
  const vehicleId = Number(form.vehicle);
  const file = event.currentTarget.elements.file.files[0];
  const id = nextId(data.maintenance);
  try {
    const fileStorageKey = file ? await saveLocalFile(file, `maintenance-${id}`) : null;
    data.maintenance.push({ id, vehicleId, type: form.type, workshop: form.workshop.trim(), entry: form.entry, exit: form.exit, cost: Number(form.cost || 0), description: form.description.trim(), status: 'Programado', evidenceFile: file?.name || '', fileStorageKey });
    recalculateVehicleFromOperations(vehicleId); saveData(); renderAll(); event.currentTarget.reset(); closeModal(q('maintenanceModal')); toast('Mantenimiento registrado.');
  } catch (error) { toast(error.message || 'No se pudo guardar el mantenimiento.'); }
});

q('returnForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = formObject(event.currentTarget);
  const assignment = assignmentById(form.assignment);
  if (!assignment) { toast('Selecciona una asignación válida.'); return; }
  const vehicle = vehicleById(assignment.vehicleId);
  if (Number(form.odometer) < Number(vehicle?.odometer || assignment.odometer)) { toast('El odómetro final no puede ser menor al actual.'); return; }
  const id = nextId(data.returns);
  const files = [...event.currentTarget.elements.files.files];
  try {
    const fileStorageKeys = [];
    for (let index = 0; index < files.length; index += 1) {
      fileStorageKeys.push(await saveLocalFile(files[index], `return-${id}-${index}`));
    }
    assignment.status = 'Cerrada'; assignment.returnedAt = form.date; assignment.returnOdometer = Number(form.odometer); assignment.returnLocation = form.location.trim(); assignment.returnCondition = form.condition; assignment.returnNotes = form.notes;
    if (vehicle) { vehicle.odometer = Number(form.odometer); vehicle.city = form.location.trim(); vehicle.status = form.condition === 'Requiere mantenimiento' ? 'Mantenimiento' : 'Disponible'; }
    data.returns.push({ id, assignmentId: assignment.id, requestDate: form.date, dueDate: form.date, location: form.location.trim(), emailEvidence: false, status: 'Devuelto', evidenceFiles: files.map((file) => file.name), fileStorageKeys });
    saveData(); renderAll(); event.currentTarget.reset(); closeModal(q('returnModal')); toast('Devolución registrada y asignación cerrada.');
  } catch (error) { toast(error.message || 'No se pudo guardar la devolución.'); }
});

// Exportaciones
q('exportButton').addEventListener('click', () => downloadPdf('complete'));
qa('[data-export-pdf]').forEach((button) => button.addEventListener('click', () => downloadPdf(button.dataset.exportPdf)));

// Autenticación
q('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!supabaseClient || !isSupabaseConfigured()) { setAuthMessage('Completa primero la configuración de Supabase.'); return; }
  const email = q('loginEmail').value.trim();
  const password = q('loginPassword').value;
  setAuthMessage(''); setLoginLoading(true);
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    setAuthMessage('Acceso correcto. Cargando FleetGuard...', 'success');
  } catch (error) {
    const message = /invalid login credentials/i.test(error.message || '') ? 'Correo o contraseña incorrectos.' : (error.message || 'No se pudo iniciar sesión.');
    setAuthMessage(message);
  } finally { setLoginLoading(false); }
});

q('logoutButton').addEventListener('click', async () => {
  if (!supabaseClient) return;
  const button = q('logoutButton');
  button.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    q('loginPassword').value = '';
    showLoginScreen('Sesión cerrada correctamente.');
  } catch (error) { toast(error.message || 'No se pudo cerrar la sesión.'); }
  finally { button.disabled = false; }
});

q('togglePassword').addEventListener('click', () => {
  const input = q('loginPassword');
  const button = q('togglePassword');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  button.textContent = showing ? 'Ver' : 'Ocultar';
  button.setAttribute('aria-label', showing ? 'Mostrar contraseña' : 'Ocultar contraseña');
});

initializeFleetGuard().catch((error) => showLoginScreen(error.message || 'No se pudo iniciar FleetGuard.'));
