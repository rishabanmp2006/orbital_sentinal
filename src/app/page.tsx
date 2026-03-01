"use client"

import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import axios from "axios"
import * as satellite from "satellite.js"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls"

export default function Home(){

const mountRef = useRef<HTMLDivElement | null>(null)

const simulationSpeed = useRef(50)

const satellitesRef = useRef<any[]>([])
const debrisRef = useRef<any[]>([])

const simTime = useRef(new Date())
const lastFrame = useRef(Date.now())

const [satCount,setSatCount] = useState(0)
const [warning,setWarning] = useState("No Collision Risk")
const [prediction,setPrediction] = useState("Scanning future orbits...")
const [selectedSat,setSelectedSat] = useState<any>(null)
const [speedUI,setSpeedUI] = useState(50)
const [paused,setPaused] = useState(false)

useEffect(()=>{

if(!mountRef.current) return

const scene = new THREE.Scene()

const camera = new THREE.PerspectiveCamera(
75,
window.innerWidth/window.innerHeight,
0.1,
3000
)

camera.position.set(0,4,10)

const renderer = new THREE.WebGLRenderer({antialias:true})
renderer.setSize(window.innerWidth,window.innerHeight)
renderer.setClearColor(0x000000)

mountRef.current.innerHTML=""
mountRef.current.appendChild(renderer.domElement)

const controls = new OrbitControls(camera,renderer.domElement)
controls.enableDamping=true
controls.enablePan=true

const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()

// EARTH

const textureLoader = new THREE.TextureLoader()
const earthTexture = textureLoader.load("/earth.jpg")

const earth = new THREE.Mesh(
new THREE.SphereGeometry(2,64,64),
new THREE.MeshStandardMaterial({map:earthTexture})
)

scene.add(earth)

const light = new THREE.PointLight(0xffffff,2)
light.position.set(5,3,5)
scene.add(light)

// STARS

const starGeometry = new THREE.BufferGeometry()
const starCount = 6000
const starPositions = new Float32Array(starCount*3)

for(let i=0;i<starCount*3;i++){
starPositions[i]=(Math.random()-0.5)*2000
}

starGeometry.setAttribute(
"position",
new THREE.BufferAttribute(starPositions,3)
)

const stars = new THREE.Points(
starGeometry,
new THREE.PointsMaterial({color:0xffffff,size:0.7})
)

scene.add(stars)

// ORBIT RINGS

function createRing(radius:number,color:number){

const geometry=new THREE.RingGeometry(radius,radius+0.01,128)

const material=new THREE.MeshBasicMaterial({
color,
side:THREE.DoubleSide,
transparent:true,
opacity:0.4
})

const mesh=new THREE.Mesh(geometry,material)
mesh.rotation.x=Math.PI/2

scene.add(mesh)

}

createRing(2.4,0x00ffff)
createRing(3.2,0xffff00)
createRing(4.5,0xff0000)

// LABEL

function createLabel(text:string){

const canvas=document.createElement("canvas")
const ctx=canvas.getContext("2d")!

canvas.width=256
canvas.height=128

ctx.fillStyle="white"
ctx.font="22px Arial"
ctx.fillText(text,20,60)

const texture=new THREE.CanvasTexture(canvas)

const sprite=new THREE.Sprite(
new THREE.SpriteMaterial({map:texture})
)

sprite.scale.set(0.7,0.35,1)

return sprite

}

const satellites:any[]=[]
satellitesRef.current=satellites

// LOAD SATELLITES

async function loadSatellites(){

const response=await axios.get("/active.txt")

const lines=response.data
.split("\n")
.map((l:string)=>l.trim())
.filter((l:string)=>l.length>0)

for(let i=0;i<lines.length;i+=3){

if(!lines[i+2]) continue

const name=lines[i]
const line1=lines[i+1]
const line2=lines[i+2]

try{

const satrec=satellite.twoline2satrec(line1,line2)

const mesh=new THREE.Mesh(
new THREE.SphereGeometry(0.05,8,8),
new THREE.MeshBasicMaterial({color:0x00ffcc})
)

const label=createLabel(name)

scene.add(mesh)
scene.add(label)

satellites.push({
name,
satrec,
mesh,
label,
lat:0,
lon:0,
alt:0,
orbitLine:null
})

if(satellites.length>=200) break

}catch(e){}

}

setSatCount(satellites.length)

}

loadSatellites()

// SPACE DEBRIS

const debris:any[]=[]
debrisRef.current=debris

for(let i=0;i<50;i++){

const mesh=new THREE.Mesh(
new THREE.SphereGeometry(0.04,8,8),
new THREE.MeshBasicMaterial({color:0xff8800})
)

scene.add(mesh)

debris.push({
mesh,
angle:Math.random()*Math.PI*2,
radius:2.5+Math.random()*1.5,
speed:0.002+Math.random()*0.003
})

}

// CLICK HANDLER

renderer.domElement.addEventListener("click",(event)=>{

mouse.x=(event.clientX/window.innerWidth)*2-1
mouse.y=-(event.clientY/window.innerHeight)*2+1

raycaster.setFromCamera(mouse,camera)

const intersects = raycaster.intersectObjects(
satellitesRef.current.map(s=>s.mesh)
)

if(intersects.length>0){

const mesh=intersects[0].object
const sat=satellitesRef.current.find(s=>s.mesh===mesh)

if(!sat) return

controls.target.copy(sat.mesh.position)

camera.position.copy(
sat.mesh.position.clone().add(new THREE.Vector3(0,1.5,2))
)

controls.update()

// ORBIT TOGGLE

if(sat.orbitLine){

scene.remove(sat.orbitLine)
sat.orbitLine=null

}else{

const points=[]

for(let i=0;i<1440;i+=5){

const future=new Date(simTime.current.getTime()+i*60000)

const pv=satellite.propagate(sat.satrec,future)

if(!pv.position) continue

const gmst=satellite.gstime(future)
const geo=satellite.eciToGeodetic(pv.position,gmst)

const lat=geo.latitude
const lon=geo.longitude
const alt=geo.height

const r=2+alt/2000

const x=r*Math.cos(lat)*Math.cos(lon)
const y=r*Math.sin(lat)
const z=-r*Math.cos(lat)*Math.sin(lon)

points.push(new THREE.Vector3(x,y,z))

}

const geometry=new THREE.BufferGeometry().setFromPoints(points)
const material=new THREE.LineBasicMaterial({color:0x00ffff})
const line=new THREE.Line(geometry,material)

scene.add(line)

sat.orbitLine=line

}

setSelectedSat({
name:sat.name,
alt:sat.alt,
lat:sat.lat,
lon:sat.lon
})

}

})

// AI FUTURE COLLISION PREDICTION

setInterval(()=>{

const sats=satellitesRef.current

if(sats.length<2) return

let danger=null

for(let t=1;t<=15;t++){

const futureTime=new Date(simTime.current.getTime()+t*60000)

for(let i=0;i<sats.length;i++){

for(let j=i+1;j<sats.length;j++){

const pv1=satellite.propagate(sats[i].satrec,futureTime)
const pv2=satellite.propagate(sats[j].satrec,futureTime)

if(!pv1.position||!pv2.position) continue

const gmst=satellite.gstime(futureTime)

const geo1=satellite.eciToGeodetic(pv1.position,gmst)
const geo2=satellite.eciToGeodetic(pv2.position,gmst)

const r1=2+geo1.height/2000
const r2=2+geo2.height/2000

const x1=r1*Math.cos(geo1.latitude)*Math.cos(geo1.longitude)
const y1=r1*Math.sin(geo1.latitude)
const z1=-r1*Math.cos(geo1.latitude)*Math.sin(geo1.longitude)

const x2=r2*Math.cos(geo2.latitude)*Math.cos(geo2.longitude)
const y2=r2*Math.sin(geo2.latitude)
const z2=-r2*Math.cos(geo2.latitude)*Math.sin(geo2.longitude)

const dist=Math.sqrt((x1-x2)**2+(y1-y2)**2+(z1-z2)**2)

if(dist<0.12){

danger={
a:sats[i].name,
b:sats[j].name,
t
}

break

}

}

if(danger) break
}

if(danger) break

}

if(danger){

setPrediction(`⚠ Future conjunction predicted
${danger.a} ↔ ${danger.b}
T-${danger.t} minutes`)

}else{

setPrediction("No dangerous conjunction predicted")

}

},5000)

// SIMULATION LOOP

const collisionDistance=0.05

const animate=()=>{

requestAnimationFrame(animate)

if(paused){
lastFrame.current = Date.now()
controls.update()
renderer.render(scene,camera)
return
}

const now = Date.now()
const delta = (now-lastFrame.current)/1000
lastFrame.current=now

simTime.current = new Date(
simTime.current.getTime()+delta*1000*simulationSpeed.current*60
)

earth.rotation.y += 0.0001

satellites.forEach((sat)=>{

const posVel=satellite.propagate(sat.satrec,simTime.current)

if(!posVel.position) return

const gmst=satellite.gstime(simTime.current)
const geo=satellite.eciToGeodetic(posVel.position,gmst)

sat.lon=geo.longitude
sat.lat=geo.latitude
sat.alt=geo.height

const radius=2+sat.alt/2000

const x=radius*Math.cos(sat.lat)*Math.cos(sat.lon)
const y=radius*Math.sin(sat.lat)
const z=-radius*Math.cos(sat.lat)*Math.sin(sat.lon)

sat.mesh.position.set(x,y,z)
sat.label.position.set(x,y+0.15,z)

})

// DEBRIS MOTION

debris.forEach(d=>{
d.angle+=d.speed
const x=d.radius*Math.cos(d.angle)
const z=d.radius*Math.sin(d.angle)
d.mesh.position.set(x,0,z)
})

controls.update()
renderer.render(scene,camera)

}

animate()

},[])

// SPEED

function changeSpeed(v:number){

simulationSpeed.current=v
setSpeedUI(v)

}

// PAUSE

function togglePause(){

setPaused(!paused)

}

return(

<>
<div ref={mountRef} style={{width:"100vw",height:"100vh"}}/>

<div style={{
position:"absolute",
top:20,
left:20,
background:"rgba(0,0,0,0.7)",
padding:"15px",
borderRadius:"10px",
color:"white",
fontFamily:"monospace",
width:"260px"
}}>

<h3>Orbital Sentinel</h3>

<p>Satellites tracked: {satCount}</p>
<p>Status: {warning}</p>

<p>Time Speed: {speedUI}x</p>

<input
type="range"
min="1"
max="200"
value={speedUI}
onChange={(e)=>changeSpeed(parseInt(e.target.value))}
style={{width:"200px"}}
/>

<br/><br/>

<button
onClick={togglePause}
style={{
padding:"6px 12px",
background:"#111",
border:"1px solid #444",
color:"white",
cursor:"pointer"
}}
>
{paused?"Resume Simulation":"Pause Simulation"}
</button>

<h4 style={{marginTop:"10px"}}>AI Prediction</h4>
<p>{prediction}</p>

</div>

{selectedSat && (

<div style={{
position:"absolute",
right:20,
top:20,
background:"rgba(0,0,0,0.8)",
padding:"20px",
color:"white",
width:"260px"
}}>

<h3>Satellite Info</h3>

<p>Name: {selectedSat.name}</p>
<p>Altitude: {selectedSat.alt?.toFixed(2)} km</p>
<p>Latitude: {selectedSat.lat?.toFixed(2)}</p>
<p>Longitude: {selectedSat.lon?.toFixed(2)}</p>

</div>

)}

</>

)

}