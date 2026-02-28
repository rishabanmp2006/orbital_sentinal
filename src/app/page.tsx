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

const startRealTime = useRef(Date.now())

const [satCount,setSatCount] = useState(0)
const [warning,setWarning] = useState("No Collision Risk")

const [selectedSat,setSelectedSat] = useState<any>(null)

const [speedUI,setSpeedUI] = useState(50)

const [prediction,setPrediction] = useState("Scanning orbits...")

const [paused,setPaused] = useState(false)

const orbitLinesRef = useRef<any[]>([])

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

// SAT STORAGE

const satellites:any[]=[]
satellitesRef.current=satellites

// LOAD SATELLITES

async function loadSatellites(){

const url="/active.txt"

const response=await axios.get(url)

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

// TOGGLE ORBIT

if(sat.orbitLine){

scene.remove(sat.orbitLine)
sat.orbitLine=null

}else{

const points=[]

for(let i=0;i<360;i+=5){

const future=new Date(Date.now()+i*60000)

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

// PANEL DATA

let nearest=null
let minDist=999

satellitesRef.current.forEach(other=>{

if(other===sat) return

const d=sat.mesh.position.distanceTo(other.mesh.position)

if(d<minDist){

minDist=d
nearest=other

}

})

setSelectedSat({
name:sat.name,
alt:sat.alt,
lat:sat.lat,
lon:sat.lon,
closest:nearest?.name || "None",
distance:minDist.toFixed(3),
risk:(1/minDist).toFixed(2)
})

}

})

// SIMULATION LOOP

const collisionDistance=0.05

const animate=()=>{

requestAnimationFrame(animate)

if(!paused){

const elapsed =
(Date.now()-startRealTime.current)/1000

const simTime = new Date(
startRealTime.current + elapsed*1000*simulationSpeed.current
)

earth.rotation.y += 0.0001 * simulationSpeed.current

satellites.forEach((sat)=>{

const posVel=satellite.propagate(sat.satrec,simTime)

if(!posVel.position) return

const gmst=satellite.gstime(simTime)

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

sat.mesh.material.color.set(0x00ffcc)

})

}

// COLLISION CHECK

let risk=false

for(let i=0;i<satellites.length;i++){

for(let j=i+1;j<satellites.length;j++){

const d=satellites[i].mesh.position.distanceTo(
satellites[j].mesh.position
)

if(d<collisionDistance){

satellites[i].mesh.material.color.set(0xff0000)
satellites[j].mesh.material.color.set(0xff0000)

risk=true

}

}

}

setWarning(risk?"⚠ Collision Risk Detected":"No Collision Risk")

controls.update()
renderer.render(scene,camera)

}

animate()

// AI PREDICTION

setInterval(()=>{

if(satellitesRef.current.length<2) return

const a=satellitesRef.current[Math.floor(Math.random()*satellitesRef.current.length)]
const b=satellitesRef.current[Math.floor(Math.random()*satellitesRef.current.length)]

if(a!==b){

const d=a.mesh.position.distanceTo(b.mesh.position)

if(d<0.2){

setPrediction(`Possible conjunction: ${a.name} ↔ ${b.name}`)

}else{

setPrediction("No high-risk conjunction detected")

}

}

},5000)

},[])

// SPEED CONTROL

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
background:"#00eaff",
border:"none",
cursor:"pointer"
}}
>
{paused?"Resume Simulation":"Pause Simulation"}
</button>

<br/><br/>

<h4>AI Prediction</h4>
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
<p>Altitude: {selectedSat.alt.toFixed(2)} km</p>
<p>Latitude: {selectedSat.lat.toFixed(2)}</p>
<p>Longitude: {selectedSat.lon.toFixed(2)}</p>

<p>Closest Satellite: {selectedSat.closest}</p>
<p>Distance: {selectedSat.distance}</p>
<p>Collision Risk Score: {selectedSat.risk}</p>

</div>

)}

</>

)

}