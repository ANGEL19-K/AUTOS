const config = window.FLEETGUARD_CONFIG || {};
const form = document.getElementById('publicPreUseForm');
const configWarning = document.getElementById('configWarning');
const message = document.getElementById('formMessage');
const submitButton = document.getElementById('submitButton');
const validateButton = document.getElementById('validateAssignmentButton');
const assignmentResult = document.getElementById('assignmentResult');
const manualNameField = document.getElementById('manualNameField');
const driverNameInput = document.getElementById('driverName');
const dniInput = document.getElementById('driverDni');
const plateInput = document.getElementById('plate');
const photoInput = document.getElementById('photo');
const preview = document.getElementById('photoPreview');
const resultBadge = document.getElementById('resultBadge');

const CHECK_ITEMS = [
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

let client = null;
let validatedAssignment = null;
let previewUrl = '';
const issuePreviewUrls = new Map();

function configured(){return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(String(config.supabaseUrl||''))&&String(config.supabasePublishableKey||'').length>20}
function cleanDni(value){return String(value||'').replace(/\D/g,'').slice(0,8)}
function cleanPlate(value){return String(value||'').toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,12)}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function showMessage(text,type='error'){message.hidden=!text;message.textContent=text;message.className=`notice ${type}`}
function setLoading(active){submitButton.disabled=active;validateButton.disabled=active;submitButton.textContent=active?'Enviando registro...':'Registrar chequeo'}
function updateClock(){const now=new Date();document.getElementById('checkDate').value=new Intl.DateTimeFormat('es-PE',{day:'2-digit',month:'2-digit',year:'numeric'}).format(now);document.getElementById('checkTime').value=new Intl.DateTimeFormat('es-PE',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(now)}
function isNonConforming(value){return value==='No conforme'||value==='Observado'}
function checkResult(){return CHECK_ITEMS.some(item=>isNonConforming(form.elements[item.field]?.value))?'Con observaciones':'Conforme'}

function clearIssuePreview(key){
  const oldUrl=issuePreviewUrls.get(key);
  if(oldUrl) URL.revokeObjectURL(oldUrl);
  issuePreviewUrls.delete(key);
  const target=form.querySelector(`[data-issue-preview="${key}"]`);
  if(target){target.hidden=true;target.innerHTML=''}
}

function syncIssueField(item,{clearWhenHidden=true}={}){
  const select=form.elements[item.field];
  const panel=form.querySelector(`[data-issue-fields="${item.key}"]`);
  const wrapper=form.querySelector(`[data-check-item="${item.key}"]`);
  const detail=form.elements[`issue_${item.key}_detail`];
  const photo=form.elements[`issue_${item.key}_photo`];
  const active=isNonConforming(select?.value);
  if(panel) panel.hidden=!active;
  wrapper?.classList.toggle('has-issue',active);
  if(detail) detail.required=active;
  if(photo) photo.required=active;
  if(!active&&clearWhenHidden){
    if(detail) detail.value='';
    if(photo) photo.value='';
    clearIssuePreview(item.key);
  }
}

function updateResult(){
  CHECK_ITEMS.forEach(item=>syncIssueField(item));
  const result=checkResult();
  resultBadge.textContent=result;
  resultBadge.classList.toggle('ok',result==='Conforme');
  resultBadge.classList.toggle('warn',result!=='Conforme');
}

function resetValidation(){validatedAssignment=null;assignmentResult.hidden=true;assignmentResult.innerHTML='';manualNameField.hidden=true;driverNameInput.required=false}

async function validateAssignment(){
  showMessage('');
  const dni=cleanDni(dniInput.value); const plate=cleanPlate(plateInput.value);
  dniInput.value=dni; plateInput.value=plate;
  if(dni.length!==8){showMessage('Ingresa un DNI válido de 8 dígitos.');return}
  if(plate.length<5){showMessage('Ingresa una placa válida.');return}
  validateButton.disabled=true; validateButton.textContent='Validando...';
  try{
    const {data,error}=await client.rpc('resolve_preuse_assignment',{p_dni:dni,p_plate:plate});
    if(error) throw error;
    const row=Array.isArray(data)?data[0]:data;
    if(row){
      validatedAssignment=row;
      driverNameInput.value=row.driver_name||'';
      manualNameField.hidden=true; driverNameInput.required=false;
      assignmentResult.hidden=false; assignmentResult.classList.remove('warning');
      assignmentResult.innerHTML=`<strong>${escapeHtml(row.driver_name||'Conductor')} · ${escapeHtml(row.plate||plate)}</strong><span>${escapeHtml(row.vehicle_label||'Unidad asignada')} · ${escapeHtml(row.team||'Sin team')} · ${escapeHtml(row.zone||'Sin zonal')}<br>Asignación validada desde ${escapeHtml(row.assignment_start||'fecha registrada')}.</span>`;
    }else{
      validatedAssignment=null;
      manualNameField.hidden=false; driverNameInput.required=true;
      assignmentResult.hidden=false; assignmentResult.classList.add('warning');
      assignmentResult.innerHTML='<strong>No se encontró la asignación en Supabase</strong><span>Puedes continuar ingresando tu nombre completo. El registro llegará al administrador marcado como “No validado” para su revisión.</span>';
      driverNameInput.focus();
    }
  }catch(error){
    validatedAssignment=null;
    manualNameField.hidden=false; driverNameInput.required=true;
    assignmentResult.hidden=false; assignmentResult.classList.add('warning');
    assignmentResult.innerHTML='<strong>No fue posible validar la asignación</strong><span>Completa tu nombre y continúa. El administrador podrá revisar el registro.</span>';
  }finally{validateButton.disabled=false;validateButton.textContent='Validar asignación'}
}

async function uploadEvidence(file,dni,plate,category='panoramica'){
  if(file.size>15*1024*1024) throw new Error(`La fotografía de ${category} supera el límite de 15 MB.`);
  const ext=(file.name.split('.').pop()||'jpg').replace(/[^a-z0-9]/gi,'').toLowerCase()||'jpg';
  const id=crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeCategory=String(category||'evidencia').replace(/[^a-z0-9-]/gi,'').toLowerCase();
  const path=`personal/${new Date().toISOString().slice(0,10)}/${cleanPlate(plate)}-${cleanDni(dni)}/${safeCategory}-${id}.${ext}`;
  const {error}=await client.storage.from('preuse-evidence').upload(path,file,{cacheControl:'3600',upsert:false,contentType:file.type||'image/jpeg'});
  if(error) throw error;
  return path;
}

async function cleanupUploaded(paths){
  const clean=paths.filter(Boolean);
  if(!clean.length) return;
  try{await client.storage.from('preuse-evidence').remove(clean)}catch{}
}

function validateIssues(){
  for(const item of CHECK_ITEMS){
    const status=form.elements[item.field]?.value||'Conforme';
    if(!isNonConforming(status)) continue;
    const detail=String(form.elements[`issue_${item.key}_detail`]?.value||'').trim();
    const file=form.elements[`issue_${item.key}_photo`]?.files?.[0];
    if(!detail){
      showMessage(`Describe qué sucede en “${item.label}”.`);
      form.elements[`issue_${item.key}_detail`]?.focus();
      return false;
    }
    if(!file){
      showMessage(`Adjunta una fotografía de evidencia para “${item.label}”.`);
      form.elements[`issue_${item.key}_photo`]?.focus();
      return false;
    }
  }
  return true;
}

async function submitCheck(event){
  event.preventDefault(); showMessage('');
  const dni=cleanDni(dniInput.value); const plate=cleanPlate(plateInput.value);
  dniInput.value=dni; plateInput.value=plate;
  const odometer=Number(document.getElementById('odometer').value);
  const photo=photoInput.files[0]; const result=checkResult();
  const generalNotes=document.getElementById('notes').value.trim();
  const driverName=(validatedAssignment?.driver_name||driverNameInput.value||'').trim();
  if(dni.length!==8){showMessage('Ingresa un DNI válido de 8 dígitos.');return}
  if(plate.length<5){showMessage('Ingresa una placa válida.');return}
  if(!validatedAssignment&&!driverName){manualNameField.hidden=false;driverNameInput.required=true;showMessage('Ingresa tu nombre completo o valida primero la asignación.');return}
  if(!Number.isFinite(odometer)||odometer<0){showMessage('Ingresa el odómetro actual.');return}
  if(!photo){showMessage('La foto panorámica del vehículo es obligatoria.');return}
  if(!validateIssues()) return;

  setLoading(true);
  const uploadedPaths=[];
  try{
    const photoPath=await uploadEvidence(photo,dni,plate,'panoramica');
    uploadedPaths.push(photoPath);

    const checks={};
    const summaries=[];
    for(const item of CHECK_ITEMS){
      const status=form.elements[item.field]?.value||'Conforme';
      if(isNonConforming(status)){
        const detail=String(form.elements[`issue_${item.key}_detail`]?.value||'').trim();
        const evidence=form.elements[`issue_${item.key}_photo`]?.files?.[0];
        const evidencePath=await uploadEvidence(evidence,dni,plate,item.key);
        uploadedPaths.push(evidencePath);
        checks[item.key]={
          status:'No conforme',
          detail,
          photo_path:evidencePath,
          photo_name:evidence.name,
          photo_mime_type:evidence.type||'image/jpeg'
        };
        summaries.push(`${item.label}: ${detail}`);
      }else{
        checks[item.key]={status};
      }
    }

    // La RPC V11 exige texto en notes cuando existe una observación. Si el trabajador
    // no escribe una observación general, se genera un resumen con los detalles por punto.
    const notesForDb=generalNotes||(summaries.length?summaries.join(' | '):null);
    const {error}=await client.rpc('submit_preuse_check',{
      p_driver_dni:dni,p_driver_name:driverName,p_plate:plate,p_odometer:odometer,p_result:result,
      p_checks:checks,p_notes:notesForDb,p_photo_path:photoPath,p_photo_name:photo.name,p_photo_mime_type:photo.type||'image/jpeg'
    });
    if(error) throw error;
    form.hidden=true; document.getElementById('successScreen').hidden=false;
    document.getElementById('successSummary').innerHTML=`<div><span>Placa</span><strong>${escapeHtml(plate)}</strong></div><div><span>Conductor</span><strong>${escapeHtml(driverName||dni)}</strong></div><div><span>Odómetro</span><strong>${odometer.toLocaleString('es-PE')} km</strong></div><div><span>Resultado</span><strong>${escapeHtml(result)}</strong></div><div><span>No conformidades</span><strong>${summaries.length}</strong></div>`;
    window.scrollTo({top:0,behavior:'smooth'});
  }catch(error){
    console.error(error);
    await cleanupUploaded(uploadedPaths);
    showMessage(error.message||'No se pudo registrar el chequeo. Intenta nuevamente.');
  }finally{setLoading(false)}
}

function resetForm(){
  form.reset(); form.hidden=false; document.getElementById('successScreen').hidden=true; resetValidation();
  CHECK_ITEMS.forEach(item=>{clearIssuePreview(item.key);syncIssueField(item)});
  updateResult(); updateClock(); showMessage('');
  if(previewUrl) URL.revokeObjectURL(previewUrl); previewUrl='';preview.hidden=true;preview.innerHTML='';window.scrollTo({top:0,behavior:'smooth'});
}

dniInput.addEventListener('input',()=>{dniInput.value=cleanDni(dniInput.value);resetValidation()});
plateInput.addEventListener('input',()=>{plateInput.value=cleanPlate(plateInput.value);resetValidation()});
validateButton.addEventListener('click',validateAssignment);
form.addEventListener('change',event=>{
  if(event.target.matches('.check-grid select')){
    const item=CHECK_ITEMS.find(candidate=>candidate.field===event.target.name);
    if(item) syncIssueField(item);
    updateResult();
  }
});
form.addEventListener('submit',submitCheck);
photoInput.addEventListener('change',()=>{if(previewUrl)URL.revokeObjectURL(previewUrl);const file=photoInput.files[0];if(!file){preview.hidden=true;preview.innerHTML='';return}previewUrl=URL.createObjectURL(file);preview.innerHTML=`<img src="${previewUrl}" alt="Vista previa de la fotografía panorámica">`;preview.hidden=false});
CHECK_ITEMS.forEach(item=>{
  const input=form.elements[`issue_${item.key}_photo`];
  input?.addEventListener('change',()=>{
    clearIssuePreview(item.key);
    const file=input.files?.[0];
    if(!file) return;
    const url=URL.createObjectURL(file); issuePreviewUrls.set(item.key,url);
    const target=form.querySelector(`[data-issue-preview="${item.key}"]`);
    if(target){target.innerHTML=`<img src="${url}" alt="Evidencia de ${escapeHtml(item.label)}">`;target.hidden=false}
  });
});
document.getElementById('newCheckButton').addEventListener('click',resetForm);

updateClock();setInterval(updateClock,1000);updateResult();
if(!configured()||!window.supabase?.createClient){configWarning.hidden=false;submitButton.disabled=true;validateButton.disabled=true}else{client=window.supabase.createClient(config.supabaseUrl,config.supabasePublishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}})}
