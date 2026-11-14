require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Pool } = require("pg");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const TZ = "America/Panama";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});

// Configuración de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadRoot = path.join(__dirname, "uploads");
for (const dir of ["horarios"]) fs.mkdirSync(path.join(uploadRoot, dir), {recursive:true});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({limit:"1mb"}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/login", rateLimit({windowMs:15*60*1000, max:20, standardHeaders:true, legacyHeaders:false}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits:{fileSize:8*1024*1024, files:1},
  fileFilter:(req,file,cb)=>cb(null, ["image/jpeg","image/png","image/webp","application/pdf"].includes(file.mimetype))
});

async function uploadToCloudinary(buffer, folder = "uploads/evidencias") {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "auto" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
}

function panamaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone:TZ, year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const o = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return {year:Number(o.year), month:Number(o.month), day:Number(o.day), date:`${o.year}-${o.month}-${o.day}`};
}
function auth(req,res,next){
  const token=req.cookies.serafo_token || (req.headers.authorization||"").replace(/^Bearer /,"");
  if(!token) return res.status(401).json({error:"Inicia sesión."});
  try { req.user=jwt.verify(token,process.env.JWT_SECRET); next(); }
  catch { res.clearCookie("serafo_token"); return res.status(401).json({error:"Sesión vencida."}); }
}
function admin(req,res,next){ if(req.user.role!=="admin") return res.status(403).json({error:"No tienes permisos."}); next(); }
function coordsValid(lat,lng,accuracy){
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) &&
    Math.abs(Number(lat))<=90 && Math.abs(Number(lng))<=180 &&
    Number.isFinite(Number(accuracy)) && Number(accuracy)>=0 && Number(accuracy)<=1000;
}
function distanceMeters(lat1,lon1,lat2,lon2){
  const rad=x=>x*Math.PI/180, R=6371000;
  const dLat=rad(lat2-lat1),dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
async function checkWorkLocation(lat,lng){
  const q=await pool.query("SELECT key,value FROM settings WHERE key IN ('work_lat','work_lng','work_radius_meters')");
  const s=Object.fromEntries(q.rows.map(r=>[r.key,r.value]));
  if(!s.work_lat || !s.work_lng) return {ok:true,configured:false};
  const distance=distanceMeters(Number(lat),Number(lng),Number(s.work_lat),Number(s.work_lng));
  const radius=Number(s.work_radius_meters||250);
  return {ok:distance<=radius,distance:Math.round(distance),radius,configured:true};
}
async function audit(userId,action,detail={}) {
  await pool.query("INSERT INTO audit_log(user_id,action,detail) VALUES($1,$2,$3)",[userId,action,JSON.stringify(detail)]);
}
async function bootstrap(){
  await pool.query(fs.readFileSync(path.join(__dirname,"schema.sql"),"utf8"));
  for (const [prefix,role] of [["ADMIN","admin"],["HELPER","helper"]]) {
    const username=process.env[`${prefix}_USERNAME`], password=process.env[`${prefix}_PASSWORD`], name=process.env[`${prefix}_NAME`] || username;
    if(!username || !password) continue;
    const hash=await bcrypt.hash(password,12);
    await pool.query(`INSERT INTO users(name,username,password_hash,role) VALUES($1,$2,$3,$4)
      ON CONFLICT(username) DO NOTHING`,[name,username,hash,role]);
  }
  const radius=process.env.WORK_RADIUS_METERS || "250";
  await pool.query("INSERT INTO settings(key,value) VALUES('work_radius_meters',$1) ON CONFLICT(key) DO NOTHING",[radius]);
}

app.get("/api/health", async(req,res)=>{ try{await pool.query("SELECT 1");res.json({ok:true,timezone:TZ});}catch(e){res.status(503).json({ok:false,error:"Base de datos no disponible"});} });
app.post("/api/login", async(req,res)=>{
  const {username,password}=req.body||{};
  if(!username||!password) return res.status(400).json({error:"Completa usuario y contraseña."});
  const q=await pool.query("SELECT id,name,username,password_hash,role FROM users WHERE username=$1 AND active=true",[String(username).trim()]);
  if(!q.rowCount || !(await bcrypt.compare(password,q.rows[0].password_hash))) return res.status(401).json({error:"Usuario o contraseña incorrectos."});
  const u=q.rows[0], token=jwt.sign({id:u.id,name:u.name,username:u.username,role:u.role},process.env.JWT_SECRET,{expiresIn:"12h"});
  res.cookie("serafo_token",token,{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:12*60*60*1000});
  await audit(u.id,"login");
  res.json({user:{id:u.id,name:u.name,username:u.username,role:u.role}});
});
app.post("/api/logout",auth,async(req,res)=>{await audit(req.user.id,"logout");res.clearCookie("serafo_token");res.json({ok:true});});
app.get("/api/me",auth,(req,res)=>res.json({user:req.user}));

app.get("/api/evidence/:filename",auth,async(req,res)=>{
  const target = req.params.filename;
  const q=await pool.query(`SELECT e.file_name FROM evidence e JOIN attendance a ON a.id=e.attendance_id
    WHERE (e.file_name = $1 OR e.file_name LIKE '%' || $1) AND ($2='admin' OR a.user_id=$3)`,[target,req.user.role,req.user.id]);
  if(!q.rowCount) return res.status(404).json({error:"Evidencia no encontrada."});
  const url = q.rows[0].file_name;
  if(url.startsWith("http")) return res.redirect(url);
  res.sendFile(url,{root:path.join(uploadRoot,"evidencias")});
});

app.get("/api/schedule/file/:filename",auth,async(req,res)=>{
  const q=await pool.query("SELECT file_name,original_name FROM schedules WHERE file_name=$1",[req.params.filename]);
  if(!q.rowCount)return res.status(404).json({error:"Horario no encontrado."});
  res.download(path.join(uploadRoot,"horarios",q.rows[0].file_name),q.rows[0].original_name);
});
app.get("/api/activities",auth,async(req,res)=>{const q=await pool.query("SELECT id,name FROM activities WHERE active=true ORDER BY id");res.json(q.rows);});

// Registro de entrada (Estricto: Solo 1 registro por día por usuario)
app.post("/api/attendance/entry",auth,upload.single("photo"),async(req,res)=>{
  try{
    if(req.user.role!=="helper") return res.status(403).json({error:"Solo el ayudante registra asistencia."});
    if(!req.file) return res.status(400).json({error:"Debes tomar una fotografía."});
    const {latitude,longitude,accuracy}=req.body;
    if(!coordsValid(latitude,longitude,accuracy)){return res.status(400).json({error:"No se pudo validar el GPS. Activa la ubicación y vuelve a intentarlo."});}
    
    const now=new Date(), p=panamaParts(now);
    
    // Validar que no exista ya un registro de asistencia para hoy
    const existing=await pool.query("SELECT id,status FROM attendance WHERE user_id=$1 AND work_date=$2",[req.user.id,p.date]);
    if(existing.rowCount){return res.status(409).json({error:"Ya existe una asistencia registrada para el día de hoy."});}

    const cloudRes = await uploadToCloudinary(req.file.buffer, "uploads/evidencias");

    const a=await pool.query(`INSERT INTO attendance(user_id,work_date,entry_at,entry_lat,entry_lng,entry_accuracy)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,entry_at,work_date`,[req.user.id,p.date,now,Number(latitude),Number(longitude),Number(accuracy)]);
    
    await pool.query(`INSERT INTO evidence(attendance_id,kind,file_name,original_name,mime_type,latitude,longitude,accuracy)
      VALUES($1,'entry',$2,$3,$4,$5,$6,$7)`,[a.rows[0].id,cloudRes.secure_url,req.file.originalname,req.file.mimetype,Number(latitude),Number(longitude),Number(accuracy)]);
    
    await audit(req.user.id,"attendance_entry",{attendanceId:a.rows[0].id,latitude:Number(latitude),longitude:Number(longitude),cloudinaryUrl:cloudRes.secure_url});
    res.json({ok:true,attendance:a.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"No se pudo registrar la entrada."});}
});

// Registro de salida (Cierra la asistencia del día permitiendo múltiples actividades)
app.post("/api/attendance/exit",auth,upload.single("photo"),async(req,res)=>{
  try{
    if(req.user.role!=="helper") return res.status(403).json({error:"Solo el ayudante registra la salida."});
    const ids=Array.isArray(req.body.activityIds)?req.body.activityIds:JSON.parse(req.body.activityIds||"[]");
    const replacement=req.body.replacement==="true";
    const {latitude,longitude,accuracy}=req.body;
    if(!coordsValid(latitude,longitude,accuracy)) return res.status(400).json({error:"Se requiere GPS válido para registrar la salida."});
    if(!Array.isArray(ids)||ids.length===0) return res.status(400).json({error:"Selecciona al menos una actividad."});
    const location=await checkWorkLocation(latitude,longitude);
    if(!location.ok){return res.status(403).json({error:`Estás fuera del área autorizada (${location.distance} m; radio ${location.radius} m).`});}
    
    const p=panamaParts();
    const activeAtt = await pool.query("SELECT id FROM attendance WHERE user_id=$1 AND work_date=$2 AND status='open'",[req.user.id, p.date]);
    if(!activeAtt.rowCount) return res.status(409).json({error:"No hay una entrada pendiente de cerrar para el día de hoy."});
    const attId = activeAtt.rows[0].id;

    let cloudRes = null;
    if(req.file) {
      cloudRes = await uploadToCloudinary(req.file.buffer, "uploads/evidencias");
    }

    const now=new Date();
    await pool.query(`UPDATE attendance SET exit_at=$1,exit_lat=$2,exit_lng=$3,exit_accuracy=$4,replacement_day=$5,status='complete' WHERE id=$6`,
      [now,Number(latitude),Number(longitude),Number(accuracy),replacement,attId]);
    
    for(const id of ids) await pool.query("INSERT INTO attendance_activities(attendance_id,activity_id) SELECT $1,id FROM activities WHERE id=$2 ON CONFLICT DO NOTHING",[attId,id]);
    
    if(req.file && cloudRes) {
      await pool.query(`INSERT INTO evidence(attendance_id,kind,file_name,original_name,mime_type,latitude,longitude,accuracy)
        VALUES($1,'exit',$2,$3,$4,$5,$6,$7)`,[attId,cloudRes.secure_url,req.file.originalname,req.file.mimetype,Number(latitude),Number(longitude),Number(accuracy)]);
    }
    await audit(req.user.id,"attendance_exit",{attendanceId:attId,activities:ids,replacement});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"No se pudo registrar la salida."});}
});

app.get("/api/attendance/today",auth,async(req,res)=>{
  const p=panamaParts();
  const q=await pool.query(`SELECT a.*,u.name,COALESCE(json_agg(DISTINCT jsonb_build_object('id',ac.id,'name',ac.name)) FILTER(WHERE ac.id IS NOT NULL),'[]') activities,
    COALESCE(json_agg(DISTINCT jsonb_build_object('kind',e.kind,'url', CASE WHEN e.file_name LIKE 'http%' THEN e.file_name ELSE '/api/evidence/'||e.file_name END)) FILTER(WHERE e.id IS NOT NULL),'[]') evidence
    FROM attendance a JOIN users u ON u.id=a.user_id
    LEFT JOIN attendance_activities aa ON aa.attendance_id=a.id LEFT JOIN activities ac ON ac.id=aa.activity_id
    LEFT JOIN evidence e ON e.attendance_id=a.id WHERE a.work_date=$1 ${req.user.role==="admin"?"":"AND a.user_id=$2"}
    GROUP BY a.id,u.name ORDER BY a.entry_at DESC`,req.user.role==="admin"?[p.date]:[p.date,req.user.id]);
  res.json(q.rows);
});

app.get("/api/attendance",auth,async(req,res)=>{
  const {month,year}=req.query, p=panamaParts();
  const m=Number(month)||p.month,y=Number(year)||p.year;
  const q=await pool.query(`SELECT a.*,u.name,COALESCE(array_agg(DISTINCT ac.name) FILTER(WHERE ac.name IS NOT NULL),'{}') activities
    FROM attendance a JOIN users u ON u.id=a.user_id LEFT JOIN attendance_activities aa ON aa.attendance_id=a.id
    LEFT JOIN activities ac ON ac.id=aa.activity_id
    WHERE EXTRACT(MONTH FROM a.work_date)=$1 AND EXTRACT(YEAR FROM a.work_date)=$2
    AND ($3='admin' OR a.user_id=$4) GROUP BY a.id,u.name ORDER BY a.work_date DESC`,[m,y,req.user.role,req.user.id]);
  res.json(q.rows);
});

app.get("/api/schedule",auth,async(req,res)=>{
  const p=panamaParts(),m=Number(req.query.month)||p.month,y=Number(req.query.year)||p.year;
  const q=await pool.query("SELECT id,year,month,original_name,uploaded_at FROM schedules WHERE year=$1 AND month=$2",[y,m]);
  res.json(q.rows[0]||null);
});

app.post("/api/schedule",auth,admin,upload.single("file"),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:"Selecciona un archivo PDF o imagen."});
  const now=panamaParts();
  if(now.day!==30 && now.day!==31){return res.status(403).json({error:"La carga de horarios solo está habilitada los días 30 y 31."});}
  const month=Number(req.body.month),year=Number(req.body.year);
  if(month<1||month>12||!year){return res.status(400).json({error:"Mes o año inválido."});}
  try{
    const exists=await pool.query("SELECT id FROM schedules WHERE month=$1 AND year=$2",[month,year]);
    if(exists.rowCount){return res.status(409).json({error:"Este horario ya fue publicado y está bloqueado."});}
    
    const cloudRes = await uploadToCloudinary(req.file.buffer, "uploads/horarios");
    await pool.query("INSERT INTO schedules(year,month,file_name,original_name,uploaded_by) VALUES($1,$2,$3,$4,$5)",[year,month,cloudRes.secure_url,req.file.originalname,req.user.id]);
    await audit(req.user.id,"schedule_published",{month,year});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"No se pudo publicar el horario."});}
});

app.get("/api/schedule/file/:filename",auth,async(req,res)=>{
  const q=await pool.query("SELECT file_name,original_name FROM schedules WHERE file_name LIKE '%' || $1",[req.params.filename]);
  if(!q.rowCount)return res.status(404).json({error:"Horario no encontrado."});
  const url = q.rows[0].file_name;
  if(url.startsWith("http")) return res.redirect(url);
  res.download(path.join(uploadRoot,"horarios",url),q.rows[0].original_name);
});

function monthName(m){return ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"][m-1];}

// Generación de Cronograma en PDF (Fechas, días y múltiples actividades sin fotos)
app.post("/api/cronograms/generate",auth,admin,async(req,res)=>{
  const p=panamaParts(),month=Number(req.body.month)||p.month,year=Number(req.body.year)||p.year;
  try{
    // Usamos TO_CHAR para asegurar que work_date llegue siempre como texto plano 'YYYY-MM-DD'
    const days=await pool.query(`SELECT TO_CHAR(a.work_date, 'YYYY-MM-DD') as work_date, u.name,
      COALESCE(array_agg(DISTINCT ac.name) FILTER(WHERE ac.name IS NOT NULL),'{}') activities, a.replacement_day
      FROM attendance a JOIN users u ON u.id=a.user_id 
      LEFT JOIN attendance_activities aa ON aa.attendance_id=a.id
      LEFT JOIN activities ac ON ac.id=aa.activity_id 
      WHERE EXTRACT(MONTH FROM a.work_date)=$1 AND EXTRACT(YEAR FROM a.work_date)=$2
      GROUP BY a.id, u.name, a.work_date ORDER BY a.work_date`,[month,year]);

    const dir=path.join(uploadRoot,"horarios"),filename=`cronograma_${monthName(month)}_${year}_${crypto.randomUUID()}.pdf`,full=path.join(dir,filename);
    const doc=new PDFDocument({size:"A4",layout:"landscape",margin:28});
    const stream=fs.createWriteStream(full);doc.pipe(stream);
    
    doc.fontSize(17).font("Helvetica-Bold").text(`CRONOGRAMA DE TRABAJO DEL MES DE ${monthName(month).toUpperCase()} ${year}`,{align:"center"});
    doc.moveDown(1);
    
    const x0=28,y0=88,w=doc.page.width-56,headerH=27,rowH=70,colW=w/7;
    const headers=["LUNES","MARTES","MIÉRCOLES","JUEVES","VIERNES","SÁBADO","DOMINGO"];
    doc.fontSize(9).font("Helvetica-Bold");
    headers.forEach((h,i)=>{doc.rect(x0+i*colW,y0,colW,headerH).fillAndStroke("#e7efe9","#9aa69d");doc.fillColor("#173b29").text(h,x0+i*colW+3,y0+9,{width:colW-6,align:"center"});});
    
    const first=new Date(Date.UTC(year,month-1,1)), offset=(first.getUTCDay()+6)%7, total=new Date(Date.UTC(year,month,0)).getUTCDate();
    
    // Agrupar actividades por fecha de forma exacta
    const byDay=new Map();
    for(const r of days.rows){
      const key=String(r.work_date).trim(); // Fecha limpia en formato YYYY-MM-DD
      if(!byDay.has(key)) byDay.set(key,[]);
      byDay.get(key).push(r);
    }

    for(let cell=0;cell<42;cell++){
      const row=Math.floor(cell/7),col=cell%7,day=cell-offset+1,x=x0+col*colW,y=y0+headerH+row*rowH;
      doc.rect(x,y,colW,rowH).stroke("#aab4ac");
      if(day>=1&&day<=total){
        doc.fillColor("#173b29").font("Helvetica-Bold").fontSize(10).text(String(day),x+5,y+5);
        const key=`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
        const records=byDay.get(key);
        
        if(records && records.length){
          doc.fillColor("#222").font("Helvetica").fontSize(7);
          let summaryLines = [];
          records.forEach(r => {
            if(Array.isArray(r.activities)){
              r.activities.forEach(act => summaryLines.push("• " + act));
            }
            if(r.replacement_day) summaryLines.push("(REPOSICIÓN)");
          });
          doc.text(summaryLines.join("\n"),x+5,y+18,{width:colW-10,height:rowH-22,ellipsis:true});
        }
      }
    }
    doc.end();
    stream.on("finish",async()=>{
      await pool.query("INSERT INTO cronograms(year,month,file_name) VALUES($1,$2,$3) ON CONFLICT(year,month) DO UPDATE SET file_name=EXCLUDED.file_name,created_at=NOW()",[year,month,filename]);
      await audit(req.user.id,"cronogram_generated",{month,year});
      res.json({ok:true,url:`/api/cronograms/${year}/${month}`,filename});
    });
    stream.on("error",e=>{console.error(e);res.status(500).json({error:"Error generando PDF."});});
  }catch(e){console.error(e);res.status(500).json({error:"No se pudo generar el cronograma."});}
});

app.get("/api/cronograms",auth,admin,async(req,res)=>{const q=await pool.query("SELECT year,month,file_name,created_at FROM cronograms ORDER BY year DESC,month DESC");res.json(q.rows);});
app.get("/api/cronograms/:year/:month",auth,admin,async(req,res)=>{
  const q=await pool.query("SELECT file_name FROM cronograms WHERE year=$1 AND month=$2",[Number(req.params.year),Number(req.params.month)]);
  if(!q.rowCount)return res.status(404).json({error:"Cronograma no encontrado."});
  res.download(path.join(uploadRoot,"horarios",q.rows[0].file_name));
});

app.get("/api/admin/summary",auth,admin,async(req,res)=>{
  const p=panamaParts();
  const q=await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='complete')::int complete,
    COUNT(*) FILTER(WHERE status='open')::int open FROM attendance
    WHERE EXTRACT(MONTH FROM work_date)=$1 AND EXTRACT(YEAR FROM work_date)=$2`,[p.month,p.year]);
  const recent=await pool.query(`SELECT a.id,a.work_date,a.entry_at,a.exit_at,a.status,a.replacement_day,u.name
    FROM attendance a JOIN users u ON u.id=a.user_id ORDER BY a.work_date DESC LIMIT 10`);
  res.json({summary:q.rows[0],recent:recent.rows});
});

app.get("/api/admin/settings",auth,admin,async(req,res)=>{
  const q=await pool.query("SELECT key,value FROM settings");
  res.json(Object.fromEntries(q.rows.map(r=>[r.key,r.value])));
});

app.put("/api/admin/settings",auth,admin,async(req,res)=>{
  const {work_lat,work_lng,work_radius_meters}=req.body;
  if(work_lat!==undefined) await pool.query("INSERT INTO settings(key,value) VALUES('work_lat',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()",[String(work_lat)]);
  if(work_lng!==undefined) await pool.query("INSERT INTO settings(key,value) VALUES('work_lng',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()",[String(work_lng)]);
  if(work_radius_meters!==undefined) await pool.query("INSERT INTO settings(key,value) VALUES('work_radius_meters',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()",[String(Math.max(25,Math.min(5000,Number(work_radius_meters))))]);
  await audit(req.user.id,"settings_updated",req.body);res.json({ok:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:"Error interno del servidor."});});

(async()=>{
  if(!process.env.JWT_SECRET || process.env.JWT_SECRET.length<24){console.error("Configura JWT_SECRET en .env con al menos 24 caracteres.");process.exit(1);}
  try{await bootstrap();app.listen(PORT,()=>console.log(`Asistencia Serafo activo en http://localhost:${PORT}`));}
  catch(e){console.error("No se pudo iniciar. Verifica PostgreSQL y schema.sql.",e);process.exit(1);}
})();
