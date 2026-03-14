"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import * as THREE from "three"
import axios from "axios"
import * as satellite from "satellite.js"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls"

// ─── Types ────────────────────────────────────────────────────────────────────

interface SatObject {
    name: string
    satrec: any
    mesh: THREE.Group
    label: THREE.Sprite
    lat: number
    lon: number
    alt: number
    orbitLine: THREE.Line | null
    position3D: THREE.Vector3
    riskLevel: "none" | "low" | "medium" | "high"
    destroyed?: boolean
}

interface DebrisObject {
    mesh: THREE.Mesh
    angle: number
    radius: number
    speed: number
    spin: number
    inclination?: number   // orbital inclination for 3D debris paths
    cascadeFragment?: boolean
    velocity?: THREE.Vector3
    life?: number
}

interface DebrisThreat {
    debrisIdx: number
    satName: string
    distance: number       // scene units
    distanceKm: number
    relativeVelocity: number  // km/s estimated
    impactProbability: number // 0-100%
    timeToClosest: string
    alertLine?: THREE.Line
}

interface ConjunctionEvent {
    id: string
    satA: string
    satB: string
    type: "sat-sat" | "debris-sat"
    distance: number
    risk: "low" | "medium" | "high"
    timeDetected: string
    tca: string            // time of closest approach (predicted)
    probability: number    // impact probability %
}

interface Conjunction {
    satA: string
    satB: string
    distance: number
    risk: "low" | "medium" | "high"
    timeDetected: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RISK_THRESHOLDS = { high: 0.15, medium: 0.30, low: 0.50 }
const RISK_COLORS = { high: 0xff2200, medium: 0xffaa00, low: 0xffff00, none: null }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCountryColor(name: string): number {
    const n = name.toUpperCase()
    if (n.includes("STARLINK") || n.includes("NAVSTAR") || n.includes("GPS")) return 0x4488ff
    if (n.includes("BEIDOU")) return 0xff3333
    if (n.includes("COSMOS") || n.includes("GLONASS")) return 0xffcc00
    if (n.includes("GSAT") || n.includes("INSAT")) return 0xff8800
    if (n.includes("GALILEO")) return 0x22cc66
    return 0xcccccc
}

function getCountryFlag(name: string): string {
    const n = name.toUpperCase()
    if (n.includes("STARLINK") || n.includes("NAVSTAR") || n.includes("GPS")) return "🇺🇸"
    if (n.includes("BEIDOU")) return "🇨🇳"
    if (n.includes("COSMOS") || n.includes("GLONASS")) return "🇷🇺"
    if (n.includes("GSAT") || n.includes("INSAT")) return "🇮🇳"
    if (n.includes("GALILEO")) return "🇪🇺"
    return "🛰️"
}

function getOrbitType(alt: number): string {
    if (alt < 2000) return "LEO"
    if (alt < 35786) return "MEO"
    return "GEO"
}

function riskLabel(r: "low" | "medium" | "high"): { color: string; bg: string; label: string } {
    if (r === "high") return { color: "#ff2200", bg: "rgba(255,34,0,0.15)", label: "HIGH RISK" }
    if (r === "medium") return { color: "#ffaa00", bg: "rgba(255,170,0,0.15)", label: "MEDIUM" }
    return { color: "#ffff00", bg: "rgba(255,255,0,0.10)", label: "LOW" }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
    const mountRef = useRef<HTMLDivElement | null>(null)
    const simulationSpeed = useRef(50)
    const pausedRef = useRef(false)
    const satellitesRef = useRef<SatObject[]>([])
    const debrisRef = useRef<DebrisObject[]>([])
    const sceneRef = useRef<THREE.Scene | null>(null)
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
    const controlsRef = useRef<OrbitControls | null>(null)
    const simTime = useRef(new Date())
    const lastFrame = useRef(Date.now())
    const collisionCheckTimer = useRef(0)
    const solarAngleRef = useRef(0)
    const solarObjectsRef = useRef<{ mesh: THREE.Object3D; orbitR: number; speed: number; angle: number }[]>([])
    const solarGroupRef = useRef<THREE.Group | null>(null)
    const kesslerActiveRef = useRef(false)
    const cascadeFragmentsRef = useRef<DebrisObject[]>([])
    const trailsRef = useRef<Map<string, THREE.Line>>(new Map())
    const trailPositionsRef = useRef<Map<string, THREE.Vector3[]>>(new Map())
    const trailsEnabledRef = useRef(true)
    const alertLinesRef = useRef<THREE.Line[]>([])
    const debrisThreatsRef = useRef<DebrisThreat[]>([])
    const issRef = useRef<THREE.Group | null>(null)
    const shadowConeRef = useRef<THREE.Mesh | null>(null)
    const TRAIL_LENGTH = 40

    const [satCount, setSatCount] = useState(0)
    const [speedUI, setSpeedUI] = useState(50)
    const [paused, setPaused] = useState(false)
    const [selectedSat, setSelectedSat] = useState<any>(null)
    const [conjunctions, setConjunctions] = useState<Conjunction[]>([])
    const [globalRisk, setGlobalRisk] = useState<"safe" | "low" | "medium" | "high">("safe")
    const [simTimeDisplay, setSimTimeDisplay] = useState("")
    const [loadingProgress, setLoadingProgress] = useState(0)
    const [loaded, setLoaded] = useState(false)
    const [activeTab, setActiveTab] = useState<"info" | "conjunctions" | "ai">("info")
    const [solarVisible, setSolarVisible] = useState(false)
    const [kesslerActive, setKesslerActive] = useState(false)
    const [kesslerPhase, setKesslerPhase] = useState<"idle" | "impact" | "cascade" | "done">("idle")
    const [cascadeCount, setCascadeCount] = useState(0)
    const [destroyedCount, setDestroyedCount] = useState(0)
    const [trailsEnabled, setTrailsEnabled] = useState(true)
    const [issData, setIssData] = useState<{ alt: number; lat: number; lon: number; inEclipse: boolean; speed: number } | null>(null)
    const [eclipsedSats, setEclipsedSats] = useState<string[]>([])
    const [showEclipseShadow, setShowEclipseShadow] = useState(true)
    const showEclipseShadowRef = useRef(true)
    const [debrisThreats, setDebrisThreats] = useState<DebrisThreat[]>([])
    const [showAlertLines, setShowAlertLines] = useState(true)
    const showAlertLinesRef = useRef(true)
    const [conjunctionTimeline, setConjunctionTimeline] = useState<ConjunctionEvent[]>([])
    const [selectedSatImpactProb, setSelectedSatImpactProb] = useState<number | null>(null)
    const [maneuverRec, setManeuverRec] = useState<string>("")
    const [maneuverLoading, setManeuverLoading] = useState(false)
    const [activeLeftTab, setActiveLeftTab] = useState<"status" | "debris" | "timeline">("status")

    // ── Search & Filter State ─────────────────────────────────────────────────
    const [searchQuery, setSearchQuery] = useState("")
    const [searchOpen, setSearchOpen] = useState(false)
    const [filterCountry, setFilterCountry] = useState<string>("ALL")
    const [filterOrbit, setFilterOrbit] = useState<string>("ALL")
    const [searchResults, setSearchResults] = useState<SatObject[]>([])

    // ── Space Weather State ───────────────────────────────────────────────────
    const [spaceWeather, setSpaceWeather] = useState<{
        kp: number; kpLabel: string; kpColor: string
        solarWind: number; density: number; bz: number
        stormLevel: string; lastUpdated: string
    } | null>(null)
    const [weatherLoading, setWeatherLoading] = useState(false)

    // ── AI State ──────────────────────────────────────────────────────────────
    const [aiNarration, setAiNarration] = useState("Initializing SENTINEL-AI... awaiting orbital data.")
    const [aiLoading, setAiLoading] = useState(false)
    const [aiQuestion, setAiQuestion] = useState("")
    const [chatHistory, setChatHistory] = useState<{ role: string; content: string }[]>([])
    const [chatMessages, setChatMessages] = useState<{ role: "ai" | "user"; text: string }[]>([])
    const lastNarratedRisk = useRef<string>("")
    const conjunctionsRef = useRef<Conjunction[]>([])
    const globalRiskRef = useRef<string>("safe")

    // ── Collision Detection ────────────────────────────────────────────────────

    const runCollisionDetection = useCallback(() => {
        const sats = satellitesRef.current.filter(s => !s.destroyed)
        const found: Conjunction[] = []

        for (let i = 0; i < sats.length; i++) {
            sats[i].riskLevel = "none"
            const mat = (sats[i].mesh.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial
            mat.color.setHex(getCountryColor(sats[i].name))
        }

        for (let i = 0; i < sats.length; i++) {
            for (let j = i + 1; j < sats.length; j++) {
                const dist = sats[i].position3D.distanceTo(sats[j].position3D)
                let risk: "low" | "medium" | "high" | null = null
                if (dist < RISK_THRESHOLDS.high) risk = "high"
                else if (dist < RISK_THRESHOLDS.medium) risk = "medium"
                else if (dist < RISK_THRESHOLDS.low) risk = "low"

                if (risk) {
                    found.push({
                        satA: sats[i].name, satB: sats[j].name,
                        distance: parseFloat((dist * 1000).toFixed(1)),
                        risk, timeDetected: new Date().toLocaleTimeString(),
                    })
                    const escalate = (sat: SatObject, r: "low" | "medium" | "high") => {
                        const order = ["none", "low", "medium", "high"]
                        if (order.indexOf(r) > order.indexOf(sat.riskLevel)) {
                            sat.riskLevel = r
                            const col = RISK_COLORS[r]
                            if (col) {
                                const mat = (sat.mesh.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial
                                mat.color.setHex(col)
                            }
                        }
                    }
                    escalate(sats[i], risk)
                    escalate(sats[j], risk)
                }
            }
        }

        found.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.risk] - { high: 0, medium: 1, low: 2 }[b.risk]))
        const top20 = found.slice(0, 20)
        setConjunctions(top20)
        conjunctionsRef.current = top20
        const newRisk = found.some(c => c.risk === "high") ? "high"
            : found.some(c => c.risk === "medium") ? "medium"
                : found.some(c => c.risk === "low") ? "low" : "safe"
        setGlobalRisk(newRisk)
        globalRiskRef.current = newRisk
    }, [])

    // ── Debris–Satellite Threat Detection ────────────────────────────────────

    const runDebrisThreatDetection = useCallback(() => {
        const scene = sceneRef.current
        if (!scene) return

        // Remove old alert lines
        alertLinesRef.current.forEach(l => scene.remove(l))
        alertLinesRef.current = []

        const sats = satellitesRef.current.filter(s => !s.destroyed)
        const debs = debrisRef.current.filter(d => !d.cascadeFragment)
        const threats: DebrisThreat[] = []

        debs.forEach((deb, di) => {
            const debPos = deb.mesh.position

            let closest: { sat: SatObject; dist: number } | null = null
            sats.forEach(sat => {
                const dist = debPos.distanceTo(sat.position3D)
                if (!closest || dist < closest.dist) closest = { sat, dist }
            })

            if (!closest) return
            const { sat, dist } = closest

            // Only track threats within 0.8 scene units (~400km)
            if (dist > 0.8) return

            // Estimate relative velocity from orbital speed difference (km/s)
            // LEO ~7.8 km/s, debris at different altitude = different speed
            const debAlt = (debPos.length() - 2) * 2000
            const satAlt = sat.alt
            const debV = Math.sqrt(398600 / (6371 + debAlt))  // vis-viva
            const satV = Math.sqrt(398600 / (6371 + satAlt))
            const relV = Math.abs(debV - satV) + 2 + Math.random() * 4  // add crossing component

            // Impact probability: simplified Pc formula based on distance + relative velocity
            // Higher velocity = less time to dodge = higher Pc
            const pc = Math.min(99.9, (1 / (dist * dist * 800)) * (relV / 10) * 100)

            // Predicted TCA (time of closest approach) — random offset for demo
            const tcaMinutes = Math.floor(5 + Math.random() * 120)
            const tca = new Date(Date.now() + tcaMinutes * 60000)
            const tcaStr = `T-${tcaMinutes}m`

            const threat: DebrisThreat = {
                debrisIdx: di,
                satName: sat.name,
                distance: dist,
                distanceKm: parseFloat((dist * 500).toFixed(1)),
                relativeVelocity: parseFloat(relV.toFixed(1)),
                impactProbability: parseFloat(pc.toFixed(2)),
                timeToClosest: tcaStr,
            }
            threats.push(threat)

            // Draw alert line between debris and satellite
            if (showAlertLinesRef.current) {
                const lineColor = dist < 0.15 ? 0xff0000 : dist < 0.35 ? 0xff8800 : 0xffff00
                const lineMat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: dist < 0.15 ? 0.9 : 0.5 })
                const lineGeo = new THREE.BufferGeometry().setFromPoints([debPos.clone(), sat.position3D.clone()])
                const alertLine = new THREE.Line(lineGeo, lineMat)
                scene.add(alertLine)
                alertLinesRef.current.push(alertLine)
                threat.alertLine = alertLine
            }
        })

        // Sort by impact probability
        threats.sort((a, b) => b.impactProbability - a.impactProbability)
        const top10 = threats.slice(0, 10)
        setDebrisThreats(top10)
        debrisThreatsRef.current = top10

        // Update conjunction timeline with debris events
        const timelineEvents: ConjunctionEvent[] = [
            ...conjunctionsRef.current.map((c, i) => ({
                id: `sat-${i}`,
                satA: c.satA, satB: c.satB,
                type: "sat-sat" as const,
                distance: c.distance / 1000,
                risk: c.risk,
                timeDetected: c.timeDetected,
                tca: `T-${Math.floor(10 + i * 18)}m`,
                probability: c.risk === "high" ? 12 + Math.random() * 15 : c.risk === "medium" ? 2 + Math.random() * 5 : Math.random() * 1.5,
            })),
            ...top10.slice(0, 5).map((t, i) => ({
                id: `deb-${i}`,
                satA: `DEBRIS-${t.debrisIdx.toString().padStart(3, "0")}`,
                satB: t.satName,
                type: "debris-sat" as const,
                distance: t.distanceKm,
                risk: t.impactProbability > 10 ? "high" as const : t.impactProbability > 1 ? "medium" as const : "low" as const,
                timeDetected: new Date().toLocaleTimeString(),
                tca: t.timeToClosest,
                probability: t.impactProbability,
            })),
        ]
        timelineEvents.sort((a, b) => a.probability - b.probability)
        setConjunctionTimeline(timelineEvents.slice(0, 12))

    }, [])

    // Update impact probability for selected satellite
    const updateSelectedSatImpactProb = useCallback(() => {
        if (!selectedSat) { setSelectedSatImpactProb(null); return }
        const threats = debrisThreatsRef.current.filter(t => t.satName === selectedSat.name)
        if (threats.length === 0) { setSelectedSatImpactProb(0); return }
        // Combined probability (1 - product of non-impact probabilities)
        const combined = 1 - threats.reduce((acc, t) => acc * (1 - t.impactProbability / 100), 1)
        setSelectedSatImpactProb(parseFloat((combined * 100).toFixed(3)))
    }, [selectedSat])

    const fetchNarration = useCallback(async (conjs: Conjunction[], risk: string, satCnt: number, customMsg?: string) => {
        setAiLoading(true)
        try {
            const res = await fetch("/api/ai", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: "narrate", conjunctions: conjs, globalRisk: risk, satCount: satCnt, customMsg }),
            })
            const data = await res.json()
            if (data.text) setAiNarration(data.text)
            else if (data.error) setAiNarration(`⚠ ${data.error}`)
        } catch (err: any) {
            setAiNarration(`⚠ Network error: ${err.message}`)
        }
        setAiLoading(false)
    }, [])

    const askAI = useCallback(async () => {
        if (!aiQuestion.trim()) return
        const question = aiQuestion.trim()
        setAiQuestion("")
        setChatMessages(prev => [...prev, { role: "user", text: question }])
        setAiLoading(true)
        try {
            const res = await fetch("/api/ai", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mode: "chat", question,
                    conjunctions: conjunctionsRef.current,
                    globalRisk: globalRiskRef.current,
                    satCount, selectedSat,
                    chatHistory: chatHistory.slice(-8),
                }),
            })
            const data = await res.json()
            if (data.text) {
                setChatMessages(prev => [...prev, { role: "ai", text: data.text }])
                setChatHistory(prev => [...prev, { role: "user", content: question }, { role: "assistant", content: data.text }])
            } else if (data.error) {
                setChatMessages(prev => [...prev, { role: "ai", text: `⚠ ${data.error}` }])
            }
        } catch (err: any) {
            setChatMessages(prev => [...prev, { role: "ai", text: `⚠ Network error: ${err.message}` }])
        }
        setAiLoading(false)
    }, [aiQuestion, chatHistory, satCount, selectedSat])

    useEffect(() => {
        if (!loaded) return
        const key = globalRisk + conjunctions.length
        if (key === lastNarratedRisk.current) return
        lastNarratedRisk.current = key
        if (globalRisk !== "safe" || conjunctions.length === 0) fetchNarration(conjunctions, globalRisk, satCount)
    }, [globalRisk, conjunctions, satCount, loaded, fetchNarration])

    useEffect(() => {
        if (loaded && satCount > 0) fetchNarration([], "safe", satCount)
    }, [loaded, satCount, fetchNarration])

    // ── Search & Filter ────────────────────────────────────────────────────────

    const runSearch = useCallback((query: string, country: string, orbit: string) => {
        const sats = satellitesRef.current.filter(s => !s.destroyed)
        const q = query.trim().toUpperCase()

        const results = sats.filter(s => {
            const matchName = q === "" || s.name.toUpperCase().includes(q)
            const matchCountry = country === "ALL" || getCountryFlag(s.name) === country
            const matchOrbit = orbit === "ALL" || getOrbitType(s.alt) === orbit
            return matchName && matchCountry && matchOrbit
        })

        setSearchResults(results.slice(0, 8))

        // Highlight matching sats
        sats.forEach(s => {
            const mat = (s.mesh.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial
            const isMatch = results.find(r => r.name === s.name)
            if (q !== "" || country !== "ALL" || orbit !== "ALL") {
                mat.color.setHex(isMatch ? 0x00ffcc : 0x222233)
            } else {
                mat.color.setHex(getCountryColor(s.name))
            }
        })
    }, [])

    const clearSearch = useCallback(() => {
        setSearchQuery("")
        setFilterCountry("ALL")
        setFilterOrbit("ALL")
        setSearchResults([])
        satellitesRef.current.forEach(s => {
            if (s.destroyed) return
            const mat = (s.mesh.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial
            mat.color.setHex(getCountryColor(s.name))
        })
    }, [])

    const flyToSat = useCallback((sat: SatObject) => {
        const camera = cameraRef.current
        const controls = controlsRef.current
        if (!camera || !controls) return
        controls.target.copy(sat.position3D)
        camera.position.copy(sat.position3D.clone().add(new THREE.Vector3(0.5, 1.0, 2.0)))
        controls.update()
        setSelectedSat({ name: sat.name, alt: sat.alt, lat: sat.lat, lon: sat.lon, riskLevel: sat.riskLevel, orbitType: getOrbitType(sat.alt), flag: getCountryFlag(sat.name) })
        setActiveTab("info")
        setSearchOpen(false)
    }, [])

    useEffect(() => {
        if (searchOpen) runSearch(searchQuery, filterCountry, filterOrbit)
    }, [searchQuery, filterCountry, filterOrbit, searchOpen, runSearch])

    // ── Space Weather ──────────────────────────────────────────────────────────

    const fetchSpaceWeather = useCallback(async () => {
        setWeatherLoading(true)
        try {
            // NOAA real-time solar wind data
            const [kpRes, solarRes] = await Promise.all([
                fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"),
                fetch("https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json"),
            ])

            const kpData = await kpRes.json()
            const solarData = await solarRes.json()

            // Latest Kp value (last entry)
            const latestKp = parseFloat(kpData[kpData.length - 1]?.[1] ?? "0")

            // Latest solar wind (last entry: [time, density, speed, temperature])
            const latestSolar = solarData[solarData.length - 1]
            const windSpeed = parseFloat(latestSolar?.[2] ?? "400")
            const density = parseFloat(latestSolar?.[1] ?? "5")

            // Bz from magnetic field data
            let bz = 0
            try {
                const bzRes = await fetch("https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json")
                const bzData = await bzRes.json()
                bz = parseFloat(bzData[bzData.length - 1]?.[3] ?? "0")
            } catch { }

            const kpColor = latestKp >= 7 ? "#ff2200" : latestKp >= 5 ? "#ffaa00" : latestKp >= 3 ? "#ffff00" : "#00ff88"
            const kpLabel = latestKp >= 7 ? "SEVERE" : latestKp >= 5 ? "STRONG" : latestKp >= 3 ? "MODERATE" : "QUIET"
            const stormLevel = latestKp >= 5 ? "⚠ GEOMAGNETIC STORM" : latestKp >= 3 ? "ELEVATED ACTIVITY" : "NOMINAL"

            setSpaceWeather({
                kp: latestKp, kpLabel, kpColor,
                solarWind: Math.round(windSpeed),
                density: parseFloat(density.toFixed(1)),
                bz: parseFloat(bz.toFixed(1)),
                stormLevel,
                lastUpdated: new Date().toLocaleTimeString(),
            })
        } catch (e) {
            // NOAA unreachable — show placeholder
            setSpaceWeather({
                kp: 2.3, kpLabel: "QUIET", kpColor: "#00ff88",
                solarWind: 412, density: 4.8, bz: -1.2,
                stormLevel: "NOMINAL",
                lastUpdated: "offline",
            })
        }
        setWeatherLoading(false)
    }, [])

    useEffect(() => {
        fetchSpaceWeather()
        const interval = setInterval(fetchSpaceWeather, 5 * 60 * 1000) // refresh every 5 min
        return () => clearInterval(interval)
    }, [fetchSpaceWeather])

    // Run debris threat detection every 1.5 seconds
    useEffect(() => {
        const interval = setInterval(() => {
            runDebrisThreatDetection()
            updateSelectedSatImpactProb()
        }, 1500)
        return () => clearInterval(interval)
    }, [runDebrisThreatDetection, updateSelectedSatImpactProb])

    // ── Maneuver Recommendation ────────────────────────────────────────────────

    const requestManeuver = useCallback(async () => {
        if (!selectedSat) return
        setManeuverLoading(true)
        setManeuverRec("")
        const threats = debrisThreatsRef.current.filter(t => t.satName === selectedSat.name)
        try {
            const res = await fetch("/api/ai", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mode: "chat",
                    question: `Generate a specific collision avoidance maneuver for satellite "${selectedSat.name}" at ${selectedSat.alt?.toFixed(0)}km (${selectedSat.orbitType}). Debris threats nearby: ${JSON.stringify(threats.slice(0, 3))}. Include exact delta-V in m/s, burn direction (prograde/retrograde/radial), timing before TCA, altitude change result, and new Pc. Be quantitatively specific. Max 75 words.`,
                    conjunctions: conjunctionsRef.current,
                    globalRisk: globalRiskRef.current,
                    satCount, selectedSat, chatHistory: [],
                }),
            })
            const data = await res.json()
            setManeuverRec(data.text || data.error || "No recommendation available")
        } catch {
            setManeuverRec("⚠ AI offline — manual planning required")
        }
        setManeuverLoading(false)
    }, [selectedSat, satCount])

    const triggerKessler = useCallback(() => {
        const scene = sceneRef.current
        if (!scene || kesslerActiveRef.current) return
        const highRisk = conjunctionsRef.current.filter(c => c.risk === "high")
        if (highRisk.length === 0) {
            alert("No HIGH RISK conjunctions detected. Speed up simulation until a HIGH RISK event appears.")
            return
        }

        kesslerActiveRef.current = true
        setKesslerActive(true)
        setKesslerPhase("impact")
        setCascadeCount(0)
        setDestroyedCount(0)

        const target = highRisk[0]
        const satA = satellitesRef.current.find(s => s.name === target.satA)
        const satB = satellitesRef.current.find(s => s.name === target.satB)

        let impactPos = new THREE.Vector3(3, 1, 0)
        if (satA) impactPos = satA.position3D.clone()

        // Flash explosion at impact
        const flashGeo = new THREE.SphereGeometry(0.3, 16, 16)
        const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 })
        const flash = new THREE.Mesh(flashGeo, flashMat)
        flash.position.copy(impactPos)
        scene.add(flash)

        // Destroy the two satellites visually
        if (satA) { satA.destroyed = true; scene.remove(satA.mesh); scene.remove(satA.label) }
        if (satB) { satB.destroyed = true; scene.remove(satB.mesh); scene.remove(satB.label) }
        setDestroyedCount(2)

        // Fade flash
        let flashOpacity = 1
        const fadeFlash = setInterval(() => {
            flashOpacity -= 0.05
            flashMat.opacity = Math.max(0, flashOpacity)
            flash.scale.setScalar(1 + (1 - flashOpacity) * 3)
            if (flashOpacity <= 0) { clearInterval(fadeFlash); scene.remove(flash) }
        }, 30)

        // Generate initial debris cloud
        const fragments: DebrisObject[] = []
        for (let i = 0; i < 80; i++) {
            const mesh = new THREE.Mesh(
                new THREE.TetrahedronGeometry(0.02 + Math.random() * 0.04),
                new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(0.08, 1, 0.5 + Math.random() * 0.3) })
            )
            mesh.position.copy(impactPos)
            scene.add(mesh)
            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 0.08,
                (Math.random() - 0.5) * 0.08,
                (Math.random() - 0.5) * 0.08
            )
            fragments.push({
                mesh, angle: 0, radius: impactPos.length(),
                speed: 0.001, spin: Math.random() * 0.05,
                cascadeFragment: true, velocity: vel, life: 300,
            })
        }
        cascadeFragmentsRef.current = fragments
        setCascadeCount(80)
        setKesslerPhase("cascade")

        // Cascade wave — every 2s, nearby sats get destroyed and spawn more debris
        let wave = 0
        const cascadeInterval = setInterval(() => {
            wave++
            if (wave > 5) {
                clearInterval(cascadeInterval)
                setKesslerPhase("done")
                setAiNarration(`⚠ KESSLER CASCADE COMPLETE: ${destroyedCount} satellites destroyed. ${cascadeFragmentsRef.current.length} debris fragments generated. LEO is now critically congested. This is the Kessler Syndrome scenario — debris begets debris in an unstoppable chain reaction.`)
                setActiveTab("ai")
                return
            }

            // Find satellites near existing fragments and destroy them
            let newDestroyed = 0
            const newFragments: DebrisObject[] = []

            satellitesRef.current.forEach(sat => {
                if (sat.destroyed) return
                const nearFragment = cascadeFragmentsRef.current.find(
                    f => f.mesh.position.distanceTo(sat.position3D) < 0.8
                )
                if (nearFragment) {
                    sat.destroyed = true
                    scene.remove(sat.mesh)
                    scene.remove(sat.label)
                    newDestroyed++

                    // Spawn more fragments from this collision
                    for (let i = 0; i < 15; i++) {
                        const mesh = new THREE.Mesh(
                            new THREE.TetrahedronGeometry(0.015 + Math.random() * 0.03),
                            new THREE.MeshBasicMaterial({ color: 0xff4400 })
                        )
                        mesh.position.copy(sat.position3D)
                        scene.add(mesh)
                        newFragments.push({
                            mesh, angle: 0, radius: sat.position3D.length(),
                            speed: 0.001, spin: Math.random() * 0.05,
                            cascadeFragment: true,
                            velocity: new THREE.Vector3(
                                (Math.random() - 0.5) * 0.05,
                                (Math.random() - 0.5) * 0.05,
                                (Math.random() - 0.5) * 0.05
                            ),
                            life: 400 + Math.random() * 200,
                        })
                    }
                }
            })

            cascadeFragmentsRef.current = [...cascadeFragmentsRef.current, ...newFragments]
            setDestroyedCount(prev => prev + newDestroyed)
            setCascadeCount(cascadeFragmentsRef.current.length)
        }, 2000)

    }, [])

    const resetKessler = useCallback(() => {
        const scene = sceneRef.current
        if (!scene) return
        cascadeFragmentsRef.current.forEach(f => scene.remove(f.mesh))
        cascadeFragmentsRef.current = []
        kesslerActiveRef.current = false
        setKesslerActive(false)
        setKesslerPhase("idle")
        setCascadeCount(0)
        setDestroyedCount(0)
        // Note: destroyed sats won't come back — user needs to reload page for full reset
    }, [])

    // ── Center on Earth ────────────────────────────────────────────────────────

    const centerOnEarth = useCallback(() => {
        const camera = cameraRef.current
        const controls = controlsRef.current
        if (!camera || !controls) return
        controls.target.set(0, 0, 0)
        camera.position.set(0, 4, 10)
        controls.update()
        setSelectedSat(null)
    }, [])

    // ── Scene Setup ────────────────────────────────────────────────────────────

    useEffect(() => {
        if (!mountRef.current) return

        const scene = new THREE.Scene()
        sceneRef.current = scene

        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000)
        camera.position.set(0, 4, 10)
        cameraRef.current = camera

        const renderer = new THREE.WebGLRenderer({ antialias: true })
        renderer.setSize(window.innerWidth, window.innerHeight)
        renderer.setPixelRatio(window.devicePixelRatio)
        renderer.setClearColor(0x000005)
        mountRef.current.innerHTML = ""
        mountRef.current.appendChild(renderer.domElement)

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.enableDamping = true
        controls.dampingFactor = 0.05
        controls.enablePan = true
        controls.minDistance = 3
        controls.maxDistance = 900
        controlsRef.current = controls

        const raycaster = new THREE.Raycaster()
        const mouse = new THREE.Vector2()

        // ── Earth ────────────────────────────────────────────────────────────────

        const textureLoader = new THREE.TextureLoader()
        const earthTexture = textureLoader.load("/earth.jpg")
        const earth = new THREE.Mesh(
            new THREE.SphereGeometry(2, 64, 64),
            new THREE.MeshPhongMaterial({ map: earthTexture, specular: 0x333333, shininess: 15 })
        )
        scene.add(earth)

        const atmosphere = new THREE.Mesh(
            new THREE.SphereGeometry(2.15, 64, 64),
            new THREE.MeshBasicMaterial({ color: 0x0044ff, transparent: true, opacity: 0.08, side: THREE.BackSide })
        )
        scene.add(atmosphere)

        const sunLight = new THREE.DirectionalLight(0xffffff, 1.5)
        sunLight.position.set(10, 5, 5)
        scene.add(sunLight)
        scene.add(new THREE.AmbientLight(0x111133, 2))

        // ── Stars ────────────────────────────────────────────────────────────────

        const starGeo = new THREE.BufferGeometry()
        const starCount = 12000
        const starPos = new Float32Array(starCount * 3)
        const starCol = new Float32Array(starCount * 3)
        for (let i = 0; i < starCount; i++) {
            starPos[i * 3] = (Math.random() - 0.5) * 4000
            starPos[i * 3 + 1] = (Math.random() - 0.5) * 4000
            starPos[i * 3 + 2] = (Math.random() - 0.5) * 4000
            const b = 0.5 + Math.random() * 0.5
            starCol[i * 3] = b; starCol[i * 3 + 1] = b; starCol[i * 3 + 2] = b + Math.random() * 0.2
        }
        starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3))
        starGeo.setAttribute("color", new THREE.BufferAttribute(starCol, 3))
        scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 0.6, vertexColors: true })))

        // ── Orbit Rings ──────────────────────────────────────────────────────────

        function createRing(radius: number, color: number, opacity: number) {
            const mesh = new THREE.Mesh(
                new THREE.RingGeometry(radius, radius + 0.012, 180),
                new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity })
            )
            mesh.rotation.x = Math.PI / 2
            scene.add(mesh)
            return mesh
        }

        createRing(2.4, 0x00ffff, 0.25)
        createRing(3.2, 0xffff00, 0.20)
        createRing(4.5, 0xff4400, 0.15)

        // ── ISS Special Model ─────────────────────────────────────────────────────
        // Distinctive model: larger, white body, big solar arrays, red glow

        const issGroup = new THREE.Group()
        scene.add(issGroup)
        issRef.current = issGroup

        // Main truss body
        const issBody = new THREE.Mesh(
            new THREE.BoxGeometry(0.22, 0.045, 0.055),
            new THREE.MeshBasicMaterial({ color: 0xffffff })
        )
        issGroup.add(issBody)

        // Solar arrays (4 pairs)
        const solarMat = new THREE.MeshBasicMaterial({ color: 0x1a3a8a })
        const arrayOffsets = [-0.09, -0.03, 0.03, 0.09]
        arrayOffsets.forEach(ox => {
            const arr1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.001, 0.14), solarMat)
            arr1.position.set(ox, 0, 0.14)
            const arr2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.001, 0.14), solarMat)
            arr2.position.set(ox, 0, -0.14)
            issGroup.add(arr1, arr2)
        })

        // Habitation modules
        const modMat = new THREE.MeshBasicMaterial({ color: 0xdddddd })
            ;[-0.055, 0, 0.055].forEach(oz => {
                const mod = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.09, 8), modMat)
                mod.rotation.z = Math.PI / 2
                mod.position.set(0, 0, oz)
                issGroup.add(mod)
            })

        // ISS glow — pulsing white halo
        const issGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.18, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.BackSide })
        )
        issGroup.add(issGlow)

        // ISS label — special gold color
        const issLabelCanvas = document.createElement("canvas")
        issLabelCanvas.width = 320; issLabelCanvas.height = 80
        const issCtx = issLabelCanvas.getContext("2d")!
        issCtx.font = "bold 20px monospace"
        issCtx.fillStyle = "#ffcc00"
        issCtx.fillText("🛸 ISS", 8, 44)
        const issLabelSprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(issLabelCanvas), transparent: true })
        )
        issLabelSprite.scale.set(0.9, 0.3, 1)
        issLabelSprite.position.set(0, 0.28, 0)
        issGroup.add(issLabelSprite)

        // ── Eclipse Shadow Cone ───────────────────────────────────────────────────
        // A dark cone extending from Earth away from the sun direction
        // Sun is at positive X in scene (sunLight.position = 10,5,5)

        const shadowConeMat = new THREE.MeshBasicMaterial({
            color: 0x000011,
            transparent: true,
            opacity: 0.55,
            side: THREE.BackSide,
        })
        // ConeGeometry(radius, height, segments)
        // Cone tip at Earth center, opens away from sun
        const shadowCone = new THREE.Mesh(
            new THREE.ConeGeometry(2.05, 12, 64, 1, true),
            shadowConeMat
        )
        // Rotate so cone opens in -X direction (away from sun at +X)
        shadowCone.rotation.z = -Math.PI / 2
        // Move so tip is at Earth center
        shadowCone.position.set(-6, 0, 0)
        scene.add(shadowCone)
        shadowConeRef.current = shadowCone

        // ── Sun ──────────────────────────────────────────────────────────────────

        const solarGroup = new THREE.Group()
        scene.add(solarGroup)
        solarGroupRef.current = solarGroup
        solarGroup.position.set(0, 0, -300)

        // Sun — solid yellow-orange, always visible
        const sun = new THREE.Mesh(
            new THREE.SphereGeometry(14, 64, 64),
            new THREE.MeshBasicMaterial({ color: 0xffdd33 })
        )
        solarGroup.add(sun)

        // Sun corona layers
        const coronaDefs = [
            { size: 17, color: 0xffaa00, opacity: 0.3 },
            { size: 21, color: 0xff6600, opacity: 0.15 },
            { size: 27, color: 0xff3300, opacity: 0.06 },
        ]
        coronaDefs.forEach(({ size, color, opacity }) => {
            solarGroup.add(new THREE.Mesh(
                new THREE.SphereGeometry(size, 32, 32),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.BackSide })
            ))
        })

        // Sun light
        const sunPointLight = new THREE.PointLight(0xffee88, 3, 3000)
        solarGroup.add(sunPointLight)

        // Planets — solid colors, no external textures
        const planetDefs = [
            { name: "Mercury", radius: 0.6, orbitR: 75, color: 0x999988, emissive: 0x222222, speed: 0.00047, tilt: 0 },
            { name: "Venus", radius: 1.2, orbitR: 120, color: 0xffcc66, emissive: 0x331100, speed: 0.00035, tilt: 177.4 * Math.PI / 180 },
            { name: "Mars", radius: 0.7, orbitR: 210, color: 0xcc4422, emissive: 0x220800, speed: 0.00024, tilt: 25.2 * Math.PI / 180 },
            { name: "Jupiter", radius: 4.8, orbitR: 360, color: 0xddaa77, emissive: 0x221100, speed: 0.00013, tilt: 3.1 * Math.PI / 180, bands: true },
            { name: "Saturn", radius: 4.0, orbitR: 500, color: 0xeedd99, emissive: 0x221a00, speed: 0.000096, tilt: 26.7 * Math.PI / 180, rings: true },
            { name: "Uranus", radius: 2.4, orbitR: 630, color: 0x88ddee, emissive: 0x001122, speed: 0.000068, tilt: 97.8 * Math.PI / 180, thinRings: true },
            { name: "Neptune", radius: 2.2, orbitR: 750, color: 0x3355ee, emissive: 0x000822, speed: 0.000054, tilt: 28.3 * Math.PI / 180 },
        ]

        const solarObjects: { mesh: THREE.Object3D; orbitR: number; speed: number; angle: number }[] = []

        planetDefs.forEach((planet: any) => {
            // Orbit ring
            const orbitRing = new THREE.Mesh(
                new THREE.RingGeometry(planet.orbitR, planet.orbitR + 0.3, 180),
                new THREE.MeshBasicMaterial({ color: 0x334466, side: THREE.DoubleSide, transparent: true, opacity: 0.3 })
            )
            orbitRing.rotation.x = Math.PI / 2
            solarGroup.add(orbitRing)

            // Planet mesh
            const planetMesh = new THREE.Mesh(
                new THREE.SphereGeometry(planet.radius, 48, 48),
                new THREE.MeshPhongMaterial({ color: planet.color, emissive: planet.emissive, shininess: 20 })
            )
            if (planet.tilt) planetMesh.rotation.z = planet.tilt

            const startAngle = Math.random() * Math.PI * 2
            planetMesh.position.set(planet.orbitR * Math.cos(startAngle), 0, planet.orbitR * Math.sin(startAngle))
            solarGroup.add(planetMesh)

            // Jupiter horizontal bands
            if (planet.bands) {
                const bandColors = [0xddaa66, 0xcc8855, 0xeebb88, 0xbb7744]
                for (let b = 0; b < 5; b++) {
                    const bandMesh = new THREE.Mesh(
                        new THREE.SphereGeometry(planet.radius * 1.001, 48, 8),
                        new THREE.MeshBasicMaterial({ color: bandColors[b % 4], transparent: true, opacity: 0.25, wireframe: false })
                    )
                    bandMesh.scale.y = 0.12
                    bandMesh.position.y = (b - 2) * planet.radius * 0.35
                    planetMesh.add(bandMesh)
                }
            }

            // Saturn rings
            if (planet.rings) {
                const ringMesh = new THREE.Mesh(
                    new THREE.RingGeometry(planet.radius * 1.3, planet.radius * 2.3, 128),
                    new THREE.MeshBasicMaterial({ color: 0xddcc88, side: THREE.DoubleSide, transparent: true, opacity: 0.75 })
                )
                ringMesh.rotation.x = Math.PI / 2.4
                planetMesh.add(ringMesh)
                // Inner darker ring
                planetMesh.add(new THREE.Mesh(
                    new THREE.RingGeometry(planet.radius * 1.1, planet.radius * 1.3, 128),
                    new THREE.MeshBasicMaterial({ color: 0x887744, side: THREE.DoubleSide, transparent: true, opacity: 0.5 })
                ))
            }

            // Uranus thin rings
            if (planet.thinRings) {
                planetMesh.add(new THREE.Mesh(
                    new THREE.RingGeometry(planet.radius * 1.4, planet.radius * 1.65, 64),
                    new THREE.MeshBasicMaterial({ color: 0xaaddee, side: THREE.DoubleSide, transparent: true, opacity: 0.35 })
                ))
            }

            // Atmosphere glow for gas giants
            if (["Jupiter", "Saturn", "Uranus", "Neptune"].includes(planet.name)) {
                planetMesh.add(new THREE.Mesh(
                    new THREE.SphereGeometry(planet.radius * 1.04, 32, 32),
                    new THREE.MeshBasicMaterial({ color: planet.color, transparent: true, opacity: 0.08, side: THREE.BackSide })
                ))
            }

            // Label sprite
            const lc = document.createElement("canvas")
            lc.width = 256; lc.height = 64
            const lx = lc.getContext("2d")!
            lx.font = "bold 22px monospace"
            lx.fillStyle = "rgba(210,235,255,0.9)"
            lx.fillText(planet.name, 10, 44)
            const labelSprite = new THREE.Sprite(
                new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(lc), transparent: true })
            )
            labelSprite.scale.set(planet.radius * 5, planet.radius * 1.8, 1)
            labelSprite.position.set(0, planet.radius + 2.5, 0)
            planetMesh.add(labelSprite)

            solarObjects.push({ mesh: planetMesh, orbitR: planet.orbitR, speed: planet.speed, angle: startAngle })
        })

        solarObjectsRef.current = solarObjects

        // ── Satellite Model ──────────────────────────────────────────────────────

        function createSatelliteModel(color: number): THREE.Group {
            const group = new THREE.Group()
            const body = new THREE.Mesh(
                new THREE.BoxGeometry(0.06, 0.06, 0.09),
                new THREE.MeshBasicMaterial({ color })
            )
            group.add(body)
            const panelMat = new THREE.MeshBasicMaterial({ color: 0x1a4a99 })
            const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.01, 0.055), panelMat)
            p1.position.x = 0.11
            const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.01, 0.055), panelMat)
            p2.position.x = -0.11
            group.add(p1, p2)
            return group
        }

        function createLabel(text: string): THREE.Sprite {
            const canvas = document.createElement("canvas")
            const ctx = canvas.getContext("2d")!
            canvas.width = 300; canvas.height = 80
            ctx.font = "bold 18px monospace"
            ctx.fillStyle = "rgba(180,220,255,0.9)"
            ctx.fillText(text.slice(0, 20), 8, 40)
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }))
            sprite.scale.set(0.8, 0.27, 1)
            return sprite
        }

        // ── Load Satellites ──────────────────────────────────────────────────────

        const satellites: SatObject[] = []
        satellitesRef.current = satellites

        async function loadSatellites() {
            const response = await axios.get("/active.txt")
            const lines = response.data.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 0)
            const total = Math.min(Math.floor(lines.length / 3), 200)
            for (let i = 0; i < lines.length; i += 3) {
                if (!lines[i + 2]) continue
                try {
                    const satrec = satellite.twoline2satrec(lines[i + 1], lines[i + 2])
                    const mesh = createSatelliteModel(getCountryColor(lines[i]))
                    const label = createLabel(lines[i])
                    scene.add(mesh); scene.add(label)
                    satellites.push({
                        name: lines[i], satrec, mesh, label,
                        lat: 0, lon: 0, alt: 0, orbitLine: null,
                        position3D: new THREE.Vector3(), riskLevel: "none",
                    })
                    setLoadingProgress(Math.floor((satellites.length / total) * 100))
                    if (satellites.length >= 200) break
                } catch (e) { }
            }
            setSatCount(satellites.length)
            setLoaded(true)
        }
        loadSatellites()

        // ── Debris ───────────────────────────────────────────────────────────────
        // Each debris piece has a random inclination so they orbit in 3D, not just equatorial

        const debris: DebrisObject[] = []
        debrisRef.current = debris
        for (let i = 0; i < 80; i++) {
            const type = Math.floor(Math.random() * 3)
            const mesh = type === 0
                ? new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.008, 0.04), new THREE.MeshBasicMaterial({ color: 0xff6600 }))
                : type === 1
                    ? new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.07, 6), new THREE.MeshBasicMaterial({ color: 0xff4400 }))
                    : new THREE.Mesh(new THREE.TetrahedronGeometry(0.04), new THREE.MeshBasicMaterial({ color: 0xff8800 }))
            scene.add(mesh)
            debris.push({
                mesh,
                angle: Math.random() * Math.PI * 2,
                radius: 2.3 + Math.random() * 2.2,
                speed: 0.0008 + Math.random() * 0.003,
                spin: Math.random() * 0.03,
                inclination: (Math.random() - 0.5) * Math.PI * 0.8,  // up to ±72° inclination
            })
        }

        // ── Click Handler ────────────────────────────────────────────────────────

        renderer.domElement.addEventListener("click", (event) => {
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1
            raycaster.setFromCamera(mouse, camera)
            const intersects = raycaster.intersectObjects(satellitesRef.current.filter(s => !s.destroyed).map(s => s.mesh), true)
            if (intersects.length > 0) {
                const mesh = intersects[0].object.parent as THREE.Group
                const sat = satellitesRef.current.find(s => s.mesh === mesh)
                if (!sat) return

                controls.target.copy(sat.mesh.position)
                camera.position.copy(sat.mesh.position.clone().add(new THREE.Vector3(0.5, 1.0, 2.0)))
                controls.update()

                if (sat.orbitLine) { scene.remove(sat.orbitLine); sat.orbitLine = null }
                else {
                    const points: THREE.Vector3[] = []
                    for (let i = 0; i < 1440; i += 4) {
                        const future = new Date(simTime.current.getTime() + i * 60000)
                        const pv = satellite.propagate(sat.satrec, future)
                        if (!pv.position) continue
                        const gmst = satellite.gstime(future)
                        const geo = satellite.eciToGeodetic(pv.position as any, gmst)
                        const r = 2 + geo.height / 2000
                        points.push(new THREE.Vector3(
                            r * Math.cos(geo.latitude) * Math.cos(geo.longitude),
                            r * Math.sin(geo.latitude),
                            -r * Math.cos(geo.latitude) * Math.sin(geo.longitude)
                        ))
                    }
                    const line = new THREE.Line(
                        new THREE.BufferGeometry().setFromPoints(points),
                        new THREE.LineBasicMaterial({ color: 0x00eeff, transparent: true, opacity: 0.6 })
                    )
                    scene.add(line)
                    sat.orbitLine = line
                }

                setSelectedSat({ name: sat.name, alt: sat.alt, lat: sat.lat, lon: sat.lon, riskLevel: sat.riskLevel, orbitType: getOrbitType(sat.alt), flag: getCountryFlag(sat.name) })
                setActiveTab("info")
            }
        })

        // ── Resize ───────────────────────────────────────────────────────────────

        const onResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight
            camera.updateProjectionMatrix()
            renderer.setSize(window.innerWidth, window.innerHeight)
        }
        window.addEventListener("resize", onResize)

        // ── Animation Loop ────────────────────────────────────────────────────────

        let animId: number

        const animate = () => {
            animId = requestAnimationFrame(animate)

            if (pausedRef.current) {
                lastFrame.current = Date.now()
                controls.update()
                renderer.render(scene, camera)
                return
            }

            const now = Date.now()
            const delta = (now - lastFrame.current) / 1000
            lastFrame.current = now

            simTime.current = new Date(simTime.current.getTime() + delta * 1000 * simulationSpeed.current * 60)

            collisionCheckTimer.current += delta
            if (collisionCheckTimer.current > 2) {
                collisionCheckTimer.current = 0
                setSimTimeDisplay(simTime.current.toUTCString().slice(0, 25))
            }

            earth.rotation.y += 0.00005

            // ── Solar system visibility based on camera distance ─────────────────
            const camDist = camera.position.length()
            const newSolarVisible = camDist > 60
            setSolarVisible(newSolarVisible)
            solarGroup.visible = true

            // Simple show/hide — no opacity fade that breaks materials
            solarGroup.traverse((child: any) => {
                if (child.isMesh || child.isSprite || child.isLine) {
                    child.visible = newSolarVisible
                }
            })

            // Orbit planets
            solarObjectsRef.current.forEach(obj => {
                obj.angle += obj.speed
                obj.mesh.position.set(
                    obj.orbitR * Math.cos(obj.angle),
                    0,
                    obj.orbitR * Math.sin(obj.angle)
                )
            })

            // ── Satellites ───────────────────────────────────────────────────────
            const eclipsedNames: string[] = []

            satellitesRef.current.forEach(sat => {
                if (sat.destroyed) return
                const pv = satellite.propagate(sat.satrec, simTime.current)
                if (!pv.position) return
                const gmst = satellite.gstime(simTime.current)
                const geo = satellite.eciToGeodetic(pv.position as any, gmst)
                sat.lon = geo.longitude; sat.lat = geo.latitude; sat.alt = geo.height
                const r = 2 + sat.alt / 2000
                const x = r * Math.cos(sat.lat) * Math.cos(sat.lon)
                const y = r * Math.sin(sat.lat)
                const z = -r * Math.cos(sat.lat) * Math.sin(sat.lon)
                sat.mesh.position.set(x, y, z)
                sat.label.position.set(x, y + 0.18, z)
                sat.position3D.set(x, y, z)

                // ── ISS detection ─────────────────────────────────────────────────
                const isISS = sat.name.toUpperCase().includes("ISS") || sat.name.toUpperCase().includes("ZARYA")
                if (isISS && issRef.current) {
                    issRef.current.position.set(x, y, z)
                    issRef.current.lookAt(0, 0, 0)  // always face Earth
                    // Eclipse check for ISS specifically
                    const inEclipse = x < 0 && Math.sqrt(y * y + z * z) < 2.05
                    const speed = parseFloat((Math.sqrt(398600 / (6371 + sat.alt))).toFixed(2))
                    setIssData({ alt: sat.alt, lat: sat.lat * 180 / Math.PI, lon: sat.lon * 180 / Math.PI, inEclipse, speed })
                    // Hide default mesh — ISS has its own special model
                    sat.mesh.visible = false
                    sat.label.visible = false
                }

                // ── Eclipse check for all sats ────────────────────────────────────
                // Simple cylindrical shadow: behind Earth (x < 0) and within Earth radius in y-z plane
                const inEclipse = x < -1.8 && Math.sqrt(y * y + z * z) < 2.0
                if (inEclipse) {
                    eclipsedNames.push(sat.name)
                    // Dim the satellite visually
                    if (!isISS) {
                        const mat = (sat.mesh.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial
                        mat.color.setHex(0x222244)
                    }
                }

                // ── Motion trail ───────────────────────────────────────────────────
                if (trailsEnabledRef.current) {
                    const key = sat.name
                    if (!trailPositionsRef.current.has(key)) trailPositionsRef.current.set(key, [])
                    const pts = trailPositionsRef.current.get(key)!
                    pts.push(new THREE.Vector3(x, y, z))
                    if (pts.length > TRAIL_LENGTH) pts.shift()

                    if (pts.length >= 2) {
                        const existingTrail = trailsRef.current.get(key)
                        if (existingTrail) scene.remove(existingTrail)

                        const trailColor = sat.riskLevel !== "none"
                            ? (RISK_COLORS[sat.riskLevel] ?? getCountryColor(sat.name))
                            : getCountryColor(sat.name)

                        const trail = new THREE.Line(
                            new THREE.BufferGeometry().setFromPoints(pts),
                            new THREE.LineBasicMaterial({ color: trailColor, transparent: true, opacity: 0.35 })
                        )
                        scene.add(trail)
                        trailsRef.current.set(key, trail)
                    }
                } else {
                    const existing = trailsRef.current.get(sat.name)
                    if (existing) { scene.remove(existing); trailsRef.current.delete(sat.name) }
                }
            })

            // Update eclipse state every frame for status display
            setEclipsedSats(eclipsedNames)

            // Show/hide shadow cone
            if (shadowConeRef.current) {
                shadowConeRef.current.visible = showEclipseShadowRef.current
            }

            // ── Debris ──────────────────────────────────────────────────────────
            debrisRef.current.forEach(d => {
                if (d.cascadeFragment) return  // cascade frags handled separately
                d.angle += d.speed
                // Apply inclination to get 3D orbit
                const x = d.radius * Math.cos(d.angle)
                const y = d.radius * Math.sin(d.angle) * Math.sin(d.inclination ?? 0)
                const z = d.radius * Math.sin(d.angle) * Math.cos(d.inclination ?? 0)
                d.mesh.position.set(x, y, z)
                d.mesh.rotation.x += d.spin; d.mesh.rotation.y += d.spin
            })

            // ── Kessler cascade fragments ────────────────────────────────────────
            cascadeFragmentsRef.current.forEach(f => {
                if (!f.velocity || !f.life) return
                f.mesh.position.add(f.velocity)
                f.mesh.rotation.x += f.spin; f.mesh.rotation.y += f.spin
                f.life--
                const mat = f.mesh.material as THREE.MeshBasicMaterial
                if (f.life < 60) mat.opacity = f.life / 60
                // Drift outward slowly
                f.velocity.multiplyScalar(0.999)
            })

            controls.update()
            renderer.render(scene, camera)
        }

        const collisionInterval = setInterval(runCollisionDetection, 3000)
        animate()

        return () => {
            cancelAnimationFrame(animId)
            clearInterval(collisionInterval)
            window.removeEventListener("resize", onResize)
            renderer.dispose()
        }
    }, [runCollisionDetection])

    // ── UI Handlers ────────────────────────────────────────────────────────────

    const changeSpeed = (v: number) => { simulationSpeed.current = v; setSpeedUI(v) }
    const togglePause = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current) }
    const toggleTrails = () => {
        trailsEnabledRef.current = !trailsEnabledRef.current
        setTrailsEnabled(trailsEnabledRef.current)
        if (!trailsEnabledRef.current) {
            const scene = sceneRef.current
            trailsRef.current.forEach(trail => scene?.remove(trail))
            trailsRef.current.clear()
            trailPositionsRef.current.clear()
        }
    }

    const toggleAlertLines = () => {
        showAlertLinesRef.current = !showAlertLinesRef.current
        setShowAlertLines(showAlertLinesRef.current)
        if (!showAlertLinesRef.current) {
            const scene = sceneRef.current
            alertLinesRef.current.forEach(l => scene?.remove(l))
            alertLinesRef.current = []
        }
    }

    const toggleEclipseShadow = () => {
        showEclipseShadowRef.current = !showEclipseShadowRef.current
        setShowEclipseShadow(showEclipseShadowRef.current)
    }

    const riskConfig = {
        safe: { color: "#00ff88", bg: "rgba(0,255,136,0.1)", border: "rgba(0,255,136,0.3)", label: "ALL CLEAR", pulse: false },
        low: { color: "#ffff00", bg: "rgba(255,255,0,0.08)", border: "rgba(255,255,0,0.3)", label: "LOW RISK", pulse: false },
        medium: { color: "#ffaa00", bg: "rgba(255,170,0,0.1)", border: "rgba(255,170,0,0.4)", label: "MEDIUM RISK", pulse: true },
        high: { color: "#ff2200", bg: "rgba(255,34,0,0.12)", border: "rgba(255,34,0,0.5)", label: "⚠ HIGH RISK", pulse: true },
    }
    const rc = riskConfig[globalRisk]

    // ─── Render ─────────────────────────────────────────────────────────────────

    return (
        <>
            <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #000005; overflow: hidden; }
        .panel {
          background: linear-gradient(135deg, rgba(5,10,25,0.92) 0%, rgba(0,5,20,0.95) 100%);
          border: 1px solid rgba(0,180,255,0.2); border-radius: 4px; color: #c8e8ff;
          font-family: 'Share Tech Mono', monospace; backdrop-filter: blur(8px);
          box-shadow: 0 0 30px rgba(0,100,255,0.1), inset 0 0 30px rgba(0,50,150,0.05);
        }
        .panel-title {
          font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: 11px;
          letter-spacing: 3px; text-transform: uppercase; color: #00ccff;
          border-bottom: 1px solid rgba(0,180,255,0.2); padding-bottom: 10px; margin-bottom: 14px;
        }
        .stat-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px;
        }
        .stat-label { color: rgba(150,200,255,0.6); font-size: 11px; }
        .stat-value { color: #e0f4ff; font-weight: bold; }
        .risk-badge {
          display: inline-block; padding: 3px 10px; border-radius: 2px;
          font-family: 'Orbitron', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 2px;
        }
        @keyframes pulse-high {
          0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(255,34,0,0.5); }
          50% { opacity: 0.7; box-shadow: 0 0 20px rgba(255,34,0,0.8); }
        }
        @keyframes pulse-med { 0%, 100% { opacity: 1; } 50% { opacity: 0.75; } }
        @keyframes kessler-flash {
          0% { opacity: 0; transform: scale(0.8); }
          20% { opacity: 1; transform: scale(1.02); }
          100% { opacity: 1; transform: scale(1); }
        }
        .conj-item {
          padding: 8px 10px; border-radius: 3px; margin-bottom: 6px;
          border-left: 3px solid; font-size: 11px; line-height: 1.6;
        }
        .tab-btn {
          flex: 1; padding: 7px 0; background: none; border: none;
          font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 1px;
          cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; text-transform: uppercase;
        }
        .tab-btn.active { color: #00ccff; border-bottom-color: #00ccff; }
        .tab-btn:not(.active) { color: rgba(150,200,255,0.45); }
        .speed-slider {
          -webkit-appearance: none; width: 100%; height: 3px; border-radius: 2px; outline: none; margin: 6px 0;
          background: linear-gradient(to right, #00ccff ${speedUI / 2}%, rgba(255,255,255,0.1) ${speedUI / 2}%);
        }
        .speed-slider::-webkit-slider-thumb {
          -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
          background: #00ccff; cursor: pointer; box-shadow: 0 0 8px rgba(0,200,255,0.6);
        }
        .action-btn {
          width: 100%; padding: 9px;
          background: rgba(0,180,255,0.08); border: 1px solid rgba(0,180,255,0.3);
          border-radius: 3px; color: #00ccff; font-family: 'Share Tech Mono', monospace;
          font-size: 12px; letter-spacing: 1.5px; cursor: pointer; transition: all 0.2s;
          text-transform: uppercase; margin-top: 10px;
        }
        .action-btn:hover { background: rgba(0,180,255,0.18); box-shadow: 0 0 12px rgba(0,180,255,0.3); }
        .action-btn.danger { color: #ff4422; border-color: rgba(255,68,34,0.4); background: rgba(255,68,34,0.06); }
        .action-btn.danger:hover { background: rgba(255,68,34,0.14); }
        .action-btn.kessler { color: #ff2200; border-color: rgba(255,34,0,0.5); background: rgba(255,34,0,0.08); }
        .action-btn.kessler:hover { background: rgba(255,34,0,0.18); box-shadow: 0 0 15px rgba(255,34,0,0.4); }
        .action-btn.reset { color: #00ff88; border-color: rgba(0,255,136,0.4); background: rgba(0,255,136,0.06); }
        .loading-bar { height: 2px; background: rgba(0,180,255,0.15); border-radius: 1px; overflow: hidden; margin: 8px 0; }
        .loading-fill { height: 100%; background: linear-gradient(90deg, #00aaff, #00ffcc); transition: width 0.3s ease; box-shadow: 0 0 8px rgba(0,200,255,0.5); }
        .scanline {
          position: fixed; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;
          background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px);
          z-index: 10;
        }
        .corner-decoration { position: fixed; width: 60px; height: 60px; pointer-events: none; z-index: 5; }
        .corner-tl { top: 12px; left: 12px; border-top: 1px solid rgba(0,200,255,0.4); border-left: 1px solid rgba(0,200,255,0.4); }
        .corner-tr { top: 12px; right: 12px; border-top: 1px solid rgba(0,200,255,0.4); border-right: 1px solid rgba(0,200,255,0.4); }
        .corner-bl { bottom: 12px; left: 12px; border-bottom: 1px solid rgba(0,200,255,0.4); border-left: 1px solid rgba(0,200,255,0.4); }
        .corner-br { bottom: 12px; right: 12px; border-bottom: 1px solid rgba(0,200,255,0.4); border-right: 1px solid rgba(0,200,255,0.4); }
        .scrollable { overflow-y: auto; max-height: 220px; }
        .scrollable::-webkit-scrollbar { width: 3px; }
        .scrollable::-webkit-scrollbar-track { background: transparent; }
        .scrollable::-webkit-scrollbar-thumb { background: rgba(0,180,255,0.3); border-radius: 2px; }
        .kessler-panel {
          animation: kessler-flash 0.5s ease-out;
          border: 1px solid rgba(255,34,0,0.6) !important;
          box-shadow: 0 0 30px rgba(255,34,0,0.3) !important;
        }
      `}</style>

            <div ref={mountRef} style={{ width: "100vw", height: "100vh" }} />
            <div className="scanline" />
            <div className="corner-decoration corner-tl" />
            <div className="corner-decoration corner-tr" />
            <div className="corner-decoration corner-bl" />
            <div className="corner-decoration corner-br" />

            {/* ── Solar System Indicator ──────────────────────────────────────────── */}
            {solarVisible && (
                <div style={{
                    position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
                    pointerEvents: "none", zIndex: 5,
                    fontFamily: "'Orbitron', sans-serif", fontSize: 11, color: "rgba(0,200,255,0.4)",
                    letterSpacing: "3px", textAlign: "center",
                }}>
                    <div style={{ fontSize: 9, marginBottom: 4 }}>HELIOCENTRIC VIEW</div>
                    <div style={{ fontSize: 9, color: "rgba(150,200,255,0.3)" }}>Zoom in to return to Earth orbit</div>
                </div>
            )}

            {/* ── Kessler Cascade Overlay ─────────────────────────────────────────── */}
            {kesslerPhase !== "idle" && (
                <div style={{
                    position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
                    zIndex: 20, textAlign: "center", pointerEvents: "none",
                }}>
                    {kesslerPhase === "impact" && (
                        <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 28, color: "#ff2200", fontWeight: 900, textShadow: "0 0 30px rgba(255,34,0,0.8)", animation: "pulse-high 0.5s infinite" }}>
                            ⚠ COLLISION DETECTED
                        </div>
                    )}
                    {kesslerPhase === "cascade" && (
                        <div>
                            <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 18, color: "#ff4400", fontWeight: 900, textShadow: "0 0 20px rgba(255,68,0,0.8)", marginBottom: 8 }}>
                                KESSLER CASCADE IN PROGRESS
                            </div>
                            <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: "#ffaa00" }}>
                                {destroyedCount} satellites destroyed · {cascadeCount} debris fragments
                            </div>
                        </div>
                    )}
                    {kesslerPhase === "done" && (
                        <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 16, color: "#ff2200", textShadow: "0 0 20px rgba(255,34,0,0.6)" }}>
                            CASCADE COMPLETE — {destroyedCount} SATELLITES LOST
                        </div>
                    )}
                </div>
            )}

            {/* ── Left Panel ─────────────────────────────────────────────────────── */}
            <div className={`panel ${kesslerActive ? "kessler-panel" : ""}`} style={{
                position: "absolute", top: 24, left: 24, width: 278, padding: "16px 18px", maxHeight: "calc(100vh - 48px)", overflowY: "auto",
            }}>
                <div className="panel-title">⬡ Orbital Sentinel</div>

                {/* Global risk banner */}
                <div style={{
                    padding: "9px 14px", borderRadius: "3px", background: rc.bg,
                    border: `1px solid ${rc.border}`, marginBottom: "12px", textAlign: "center",
                    ...(rc.pulse && globalRisk === "high" ? { animation: "pulse-high 1.2s ease-in-out infinite" } : {}),
                    ...(rc.pulse && globalRisk === "medium" ? { animation: "pulse-med 2s ease-in-out infinite" } : {}),
                }}>
                    <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: "13px", fontWeight: 900, color: rc.color, letterSpacing: "2px" }}>{rc.label}</div>
                    <div style={{ fontSize: "10px", color: "rgba(150,200,255,0.5)", marginTop: 2 }}>
                        {conjunctions.length} sat conjunctions · {debrisThreats.filter(t => t.impactProbability > 1).length} debris threats
                    </div>
                </div>

                {/* Left panel tabs */}
                <div style={{ display: "flex", marginBottom: 12, borderBottom: "1px solid rgba(0,180,255,0.15)" }}>
                    {(["status", "debris", "timeline"] as const).map(tab => (
                        <button key={tab} className={`tab-btn ${activeLeftTab === tab ? "active" : ""}`}
                            onClick={() => setActiveLeftTab(tab)} style={{ fontSize: 9, letterSpacing: "0.5px" }}>
                            {tab === "status" ? "STATUS" : tab === "debris" ? `DEBRIS (${debrisThreats.length})` : "TIMELINE"}
                        </button>
                    ))}
                </div>

                {/* STATUS TAB */}
                {activeLeftTab === "status" && (<>
                    <div className="stat-row"><span className="stat-label">TRACKED OBJECTS</span><span className="stat-value">{satCount - destroyedCount}</span></div>
                    <div className="stat-row"><span className="stat-label">DEBRIS TRACKED</span><span className="stat-value">{80 + cascadeCount}</span></div>
                    <div className="stat-row"><span className="stat-label">ACTIVE THREATS</span>
                        <span style={{ color: debrisThreats.filter(t => t.impactProbability > 5).length > 0 ? "#ff4400" : "#00ff88", fontWeight: "bold" }}>
                            {debrisThreats.filter(t => t.impactProbability > 5).length}
                        </span>
                    </div>
                    {destroyedCount > 0 && (
                        <div className="stat-row"><span className="stat-label">DESTROYED</span><span className="stat-value" style={{ color: "#ff2200" }}>{destroyedCount}</span></div>
                    )}
                    <div className="stat-row" style={{ marginBottom: 12 }}>
                        <span className="stat-label">SIM TIME</span>
                        <span className="stat-value" style={{ fontSize: 10 }}>{simTimeDisplay || "—"}</span>
                    </div>

                    {!loaded && (
                        <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 10, color: "rgba(0,200,255,0.6)", marginBottom: 4 }}>LOADING TLE DATA... {loadingProgress}%</div>
                            <div className="loading-bar"><div className="loading-fill" style={{ width: `${loadingProgress}%` }} /></div>
                        </div>
                    )}

                    <div style={{ marginTop: 6, marginBottom: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                            <span className="stat-label">TIME WARP</span>
                            <span style={{ color: "#00ccff", fontWeight: "bold" }}>{speedUI}×</span>
                        </div>
                        <input type="range" min={1} max={200} value={speedUI}
                            onChange={(e) => changeSpeed(parseInt(e.target.value))} className="speed-slider" />
                    </div>

                    <button onClick={togglePause} className={`action-btn ${paused ? "" : "danger"}`} style={{ marginTop: 0 }}>
                        {paused ? "▶ RESUME SIMULATION" : "⏸ PAUSE SIMULATION"}
                    </button>
                    {!kesslerActive ? (
                        <button onClick={triggerKessler} className="action-btn kessler">☢ KESSLER CASCADE SIM</button>
                    ) : (
                        <button onClick={resetKessler} className="action-btn reset">↺ RESET CASCADE</button>
                    )}
                    {kesslerActive && (
                        <div style={{ marginTop: 6, padding: "5px 8px", background: "rgba(255,34,0,0.08)", border: "1px solid rgba(255,34,0,0.2)", borderRadius: 3, fontSize: 10, color: "rgba(255,150,100,0.8)", lineHeight: 1.5 }}>
                            {kesslerPhase === "cascade" && `Cascade wave... ${destroyedCount} destroyed`}
                            {kesslerPhase === "done" && `Cascade complete. Reload to restore.`}
                        </div>
                    )}
                </>)}

                {/* DEBRIS THREATS TAB */}
                {activeLeftTab === "debris" && (<>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <span style={{ fontSize: 10, color: "rgba(150,200,255,0.5)" }}>DEBRIS–SAT PROXIMITY</span>
                        <button onClick={toggleAlertLines} style={{ fontSize: 9, background: "none", border: `1px solid ${showAlertLines ? "rgba(255,180,0,0.4)" : "rgba(100,100,100,0.3)"}`, borderRadius: 2, color: showAlertLines ? "#ffcc00" : "rgba(150,150,150,0.5)", padding: "2px 7px", cursor: "pointer", fontFamily: "'Share Tech Mono', monospace" }}>
                            {showAlertLines ? "⚡ LINES ON" : "○ LINES OFF"}
                        </button>
                    </div>

                    {debrisThreats.length === 0 ? (
                        <div style={{ textAlign: "center", padding: "20px 0", color: "rgba(150,200,255,0.3)", fontSize: 11 }}>No debris threats in range</div>
                    ) : debrisThreats.map((t, i) => {
                        const pcColor = t.impactProbability > 10 ? "#ff2200" : t.impactProbability > 1 ? "#ffaa00" : "#ffff44"
                        return (
                            <div key={i} style={{ padding: "8px 10px", marginBottom: 6, background: "rgba(255,80,0,0.06)", border: `1px solid ${pcColor}44`, borderLeft: `3px solid ${pcColor}`, borderRadius: 3, fontSize: 11 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                    <span style={{ color: "#ff8844", fontSize: 9, fontFamily: "'Orbitron', sans-serif", letterSpacing: "1px" }}>
                                        DEB-{t.debrisIdx.toString().padStart(3, "0")}
                                    </span>
                                    <span style={{ color: pcColor, fontWeight: "bold", fontSize: 10 }}>Pc {t.impactProbability.toFixed(2)}%</span>
                                </div>
                                <div style={{ color: "#c8e8ff", marginBottom: 2 }}>↔ {t.satName.slice(0, 20)}</div>
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(150,200,255,0.5)" }}>
                                    <span>{t.distanceKm} km</span>
                                    <span>{t.relativeVelocity} km/s rel-v</span>
                                    <span>{t.timeToClosest}</span>
                                </div>
                            </div>
                        )
                    })}
                </>)}

                {/* CONJUNCTION TIMELINE TAB */}
                {activeLeftTab === "timeline" && (<>
                    <div style={{ fontSize: 10, color: "rgba(150,200,255,0.4)", marginBottom: 8 }}>NEXT 24H PREDICTED EVENTS</div>
                    {conjunctionTimeline.length === 0 ? (
                        <div style={{ textAlign: "center", padding: "20px 0", color: "rgba(150,200,255,0.3)", fontSize: 11 }}>No predicted events</div>
                    ) : conjunctionTimeline.map((ev, i) => {
                        const evColor = ev.risk === "high" ? "#ff2200" : ev.risk === "medium" ? "#ffaa00" : "#ffff44"
                        const typeIcon = ev.type === "debris-sat" ? "🔶" : "🔵"
                        return (
                            <div key={i} style={{ padding: "7px 10px", marginBottom: 5, background: `${evColor}0d`, borderLeft: `3px solid ${evColor}`, borderRadius: 3, fontSize: 10, lineHeight: 1.6 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                                    <span style={{ color: evColor, fontFamily: "'Orbitron', sans-serif", fontSize: 8, letterSpacing: "1px" }}>
                                        {typeIcon} {ev.type === "debris-sat" ? "DEBRIS THREAT" : "SAT CONJUNCTION"}
                                    </span>
                                    <span style={{ color: "#00ccff", fontSize: 9 }}>{ev.tca}</span>
                                </div>
                                <div style={{ color: "#c8e8ff" }}>{ev.satA.slice(0, 16)} ↔ {ev.satB.slice(0, 16)}</div>
                                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2, color: "rgba(150,200,255,0.5)" }}>
                                    <span>Pc: <span style={{ color: evColor }}>{ev.probability.toFixed(2)}%</span></span>
                                    <span>{ev.distance.toFixed(1)} km</span>
                                </div>
                                {/* Probability bar */}
                                <div style={{ marginTop: 4, height: 2, background: "rgba(255,255,255,0.08)", borderRadius: 1 }}>
                                    <div style={{ height: "100%", width: `${Math.min(100, ev.probability * 5)}%`, background: evColor, borderRadius: 1 }} />
                                </div>
                            </div>
                        )
                    })}
                </>)}
            </div>

            {/* ── Right Panel ────────────────────────────────────────────────────── */}
            <div className="panel" style={{ position: "absolute", top: 24, right: 24, width: 290, padding: "18px 20px" }}>
                <div style={{ display: "flex", marginBottom: 16, borderBottom: "1px solid rgba(0,180,255,0.15)" }}>
                    <button className={`tab-btn ${activeTab === "info" ? "active" : ""}`} onClick={() => setActiveTab("info")}>Satellite</button>
                    <button className={`tab-btn ${activeTab === "conjunctions" ? "active" : ""}`} onClick={() => setActiveTab("conjunctions")}>
                        Risk {conjunctions.length > 0 && `(${conjunctions.length})`}
                    </button>
                    <button className={`tab-btn ${activeTab === "ai" ? "active" : ""}`} onClick={() => setActiveTab("ai")}>AI ✦</button>
                </div>

                {/* Satellite Tab */}
                {activeTab === "info" && (
                    <>
                        {selectedSat ? (
                            <>
                                <div style={{ marginBottom: 12 }}>
                                    <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 12, color: "#00ccff", fontWeight: 700 }}>
                                        {selectedSat.flag} {selectedSat.name}
                                    </div>
                                    <div style={{ fontSize: 10, color: "rgba(150,200,255,0.5)", marginTop: 2 }}>{selectedSat.orbitType} ORBIT</div>
                                </div>
                                <div className="stat-row"><span className="stat-label">ALTITUDE</span><span className="stat-value">{selectedSat.alt?.toFixed(1)} km</span></div>
                                <div className="stat-row"><span className="stat-label">LATITUDE</span><span className="stat-value">{(selectedSat.lat * 180 / Math.PI).toFixed(3)}°</span></div>
                                <div className="stat-row"><span className="stat-label">LONGITUDE</span><span className="stat-value">{(selectedSat.lon * 180 / Math.PI).toFixed(3)}°</span></div>
                                <div className="stat-row">
                                    <span className="stat-label">RISK LEVEL</span>
                                    <span>
                                        {selectedSat.riskLevel === "none"
                                            ? <span style={{ color: "#00ff88", fontSize: 11 }}>NOMINAL</span>
                                            : <span className="risk-badge" style={{ color: riskLabel(selectedSat.riskLevel).color, background: riskLabel(selectedSat.riskLevel).bg }}>
                                                {riskLabel(selectedSat.riskLevel).label}
                                            </span>
                                        }
                                    </span>
                                </div>

                                {/* ── Impact Probability Meter ─────────────────────────── */}
                                <div style={{ marginTop: 14, padding: "10px 12px", background: "rgba(255,60,0,0.06)", border: "1px solid rgba(255,100,0,0.2)", borderRadius: 3 }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                                        <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 8, color: "rgba(255,150,100,0.7)", letterSpacing: "1.5px" }}>DEBRIS IMPACT PROBABILITY</span>
                                        <span style={{ fontSize: 13, fontWeight: "bold", color: selectedSatImpactProb != null && selectedSatImpactProb > 5 ? "#ff2200" : selectedSatImpactProb != null && selectedSatImpactProb > 0.5 ? "#ffaa00" : "#00ff88" }}>
                                            {selectedSatImpactProb != null ? `${selectedSatImpactProb.toFixed(3)}%` : "—"}
                                        </span>
                                    </div>
                                    {/* Gauge bar */}
                                    <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                                        <div style={{
                                            height: "100%",
                                            width: `${Math.min(100, (selectedSatImpactProb ?? 0) * 10)}%`,
                                            background: selectedSatImpactProb != null && selectedSatImpactProb > 5 ? "linear-gradient(90deg,#ff4400,#ff0000)" : selectedSatImpactProb != null && selectedSatImpactProb > 0.5 ? "linear-gradient(90deg,#ff8800,#ffcc00)" : "#00ff88",
                                            borderRadius: 3, transition: "width 0.5s ease",
                                        }} />
                                    </div>
                                    <div style={{ fontSize: 9, color: "rgba(150,200,255,0.35)", marginTop: 4 }}>
                                        {debrisThreats.filter(t => t.satName === selectedSat.name).length} debris objects within tracking range
                                    </div>
                                </div>

                                {/* ── Maneuver Recommendation ──────────────────────────── */}
                                <button onClick={requestManeuver} disabled={maneuverLoading}
                                    style={{ marginTop: 10, width: "100%", padding: "8px", background: "rgba(0,255,180,0.07)", border: "1px solid rgba(0,255,180,0.25)", borderRadius: 3, color: "#00ffcc", fontFamily: "'Share Tech Mono', monospace", fontSize: 10, letterSpacing: "1.5px", cursor: maneuverLoading ? "wait" : "pointer", textTransform: "uppercase" }}>
                                    {maneuverLoading ? "⟳ COMPUTING MANEUVER..." : "🛸 AI MANEUVER RECOMMENDATION"}
                                </button>

                                {maneuverRec && (
                                    <div style={{ marginTop: 8, padding: "10px 12px", background: "rgba(0,255,180,0.05)", border: "1px solid rgba(0,255,180,0.15)", borderRadius: 3, fontSize: 11, lineHeight: 1.65, color: "#c8e8ff" }}>
                                        <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 8, color: "rgba(0,255,180,0.5)", letterSpacing: "1.5px", marginBottom: 6 }}>SENTINEL-AI MANEUVER PLAN</div>
                                        {maneuverRec}
                                    </div>
                                )}

                                <div style={{ marginTop: 10, padding: "7px 10px", background: "rgba(0,180,255,0.05)", borderRadius: 3, fontSize: 10, color: "rgba(150,200,255,0.5)" }}>
                                    💡 Click satellite again to toggle orbit path
                                </div>
                            </>
                        ) : (
                            <div style={{ textAlign: "center", padding: "30px 0", color: "rgba(150,200,255,0.35)", fontSize: 12 }}>
                                <div style={{ fontSize: 28, marginBottom: 10 }}>🛰️</div>
                                <div>Click any satellite<br />to inspect it</div>
                            </div>
                        )}
                    </>
                )}

                {/* Conjunctions Tab */}
                {activeTab === "conjunctions" && (
                    <div className="scrollable">
                        {conjunctions.length === 0 ? (
                            <div style={{ textAlign: "center", padding: "30px 0", color: "rgba(150,200,255,0.35)", fontSize: 12 }}>
                                <div style={{ fontSize: 24, marginBottom: 10 }}>✅</div>
                                <div>No conjunctions detected<br />in current timeframe</div>
                            </div>
                        ) : conjunctions.map((c, i) => {
                            const rl = riskLabel(c.risk)
                            return (
                                <div key={i} className="conj-item" style={{ background: rl.bg, borderLeftColor: rl.color }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                        <span className="risk-badge" style={{ color: rl.color, background: "transparent", padding: 0, fontSize: 9, letterSpacing: "1.5px" }}>{rl.label}</span>
                                        <span style={{ fontSize: 10, color: "rgba(150,200,255,0.4)" }}>{c.timeDetected}</span>
                                    </div>
                                    <div style={{ color: "#c8e8ff", fontSize: 11 }}>{c.satA.slice(0, 18)} ↔ {c.satB.slice(0, 18)}</div>
                                    <div style={{ color: rl.color, fontSize: 10, marginTop: 2 }}>Δ {c.distance} m separation</div>
                                </div>
                            )
                        })}
                    </div>
                )}

                {/* AI Tab */}
                {activeTab === "ai" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ padding: "12px 14px", background: "rgba(0,180,255,0.05)", border: "1px solid rgba(0,180,255,0.15)", borderRadius: 3, fontSize: 12, lineHeight: 1.65, color: "#c8e8ff", minHeight: 80 }}>
                            <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 9, color: "rgba(0,200,255,0.5)", letterSpacing: "2px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span>SENTINEL-AI BRIEFING</span>
                                <button onClick={() => fetchNarration(conjunctionsRef.current, globalRiskRef.current, satCount)}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(0,200,255,0.5)", fontSize: 11, padding: 0 }}>↻</button>
                            </div>
                            {aiLoading && chatMessages.length === 0
                                ? <div style={{ color: "rgba(0,200,255,0.5)", fontSize: 11 }}><span style={{ animation: "pulse-med 1s infinite" }}>● </span>Analyzing orbital data...</div>
                                : <div>{aiNarration}</div>
                            }
                        </div>

                        {chatMessages.length > 0 && (
                            <div className="scrollable" style={{ maxHeight: 180, display: "flex", flexDirection: "column", gap: 8 }}>
                                {chatMessages.map((msg, i) => (
                                    <div key={i} style={{
                                        padding: "8px 10px", borderRadius: 3, fontSize: 11, lineHeight: 1.6,
                                        background: msg.role === "user" ? "rgba(0,100,200,0.12)" : "rgba(0,180,100,0.08)",
                                        borderLeft: `2px solid ${msg.role === "user" ? "rgba(0,150,255,0.4)" : "rgba(0,200,100,0.4)"}`,
                                        color: msg.role === "user" ? "rgba(150,200,255,0.8)" : "#c8e8ff",
                                    }}>
                                        <div style={{ fontSize: 9, fontFamily: "'Orbitron', sans-serif", letterSpacing: "1px", marginBottom: 4, opacity: 0.5 }}>
                                            {msg.role === "user" ? "YOU" : "SENTINEL-AI"}
                                        </div>
                                        {msg.text}
                                    </div>
                                ))}
                                {aiLoading && <div style={{ padding: "8px 10px", fontSize: 11, color: "rgba(0,200,100,0.5)" }}><span style={{ animation: "pulse-med 1s infinite" }}>● </span>Thinking...</div>}
                            </div>
                        )}

                        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                            <input type="text" value={aiQuestion} onChange={e => setAiQuestion(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && askAI()} placeholder="Ask about orbits, risks..."
                                style={{ flex: 1, background: "rgba(0,10,30,0.8)", border: "1px solid rgba(0,180,255,0.25)", borderRadius: 3, color: "#c8e8ff", fontFamily: "'Share Tech Mono', monospace", fontSize: 11, padding: "7px 10px", outline: "none" }} />
                            <button onClick={askAI} disabled={aiLoading || !aiQuestion.trim()}
                                style={{ padding: "7px 12px", background: aiLoading ? "rgba(0,100,200,0.1)" : "rgba(0,180,255,0.15)", border: "1px solid rgba(0,180,255,0.3)", borderRadius: 3, color: "#00ccff", fontFamily: "'Share Tech Mono', monospace", fontSize: 13, cursor: aiLoading ? "not-allowed" : "pointer", opacity: aiLoading ? 0.5 : 1 }}>→</button>
                        </div>

                        <div style={{ fontSize: 10, color: "rgba(150,200,255,0.35)", marginTop: 2 }}>
                            {["What's the biggest risk right now?", "Explain Kessler Syndrome", "Which country has most sats?"].map((q, i) => (
                                <span key={i} onClick={() => setAiQuestion(q)}
                                    style={{ display: "inline-block", marginRight: 6, marginBottom: 4, padding: "2px 7px", border: "1px solid rgba(0,180,255,0.15)", borderRadius: 2, cursor: "pointer", transition: "all 0.15s" }}
                                    onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(0,180,255,0.4)")}
                                    onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(0,180,255,0.15)")}
                                >{q}</span>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Search & Filter Panel ────────────────────────────────────────────── */}
            <div style={{ position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)", zIndex: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>

                {/* Search toggle button */}
                <button onClick={() => { setSearchOpen(o => !o); if (!searchOpen) runSearch(searchQuery, filterCountry, filterOrbit) }}
                    style={{ background: "rgba(0,5,20,0.88)", border: `1px solid ${searchOpen ? "rgba(0,200,255,0.5)" : "rgba(0,180,255,0.2)"}`, borderRadius: 4, padding: "7px 18px", color: searchOpen ? "#00ffcc" : "#00ccff", fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: "2px", cursor: "pointer", backdropFilter: "blur(8px)", transition: "all 0.2s" }}>
                    {searchOpen ? "✕ CLOSE SEARCH" : "⌕ SEARCH SATELLITES"}
                </button>

                {searchOpen && (
                    <div className="panel" style={{ width: 360, padding: "14px 16px" }}>
                        {/* Search input */}
                        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                            <input
                                autoFocus
                                type="text"
                                value={searchQuery}
                                onChange={e => { setSearchQuery(e.target.value); runSearch(e.target.value, filterCountry, filterOrbit) }}
                                placeholder="Search by name (e.g. STARLINK, COSMOS...)"
                                style={{ flex: 1, background: "rgba(0,10,30,0.9)", border: "1px solid rgba(0,180,255,0.3)", borderRadius: 3, color: "#c8e8ff", fontFamily: "'Share Tech Mono', monospace", fontSize: 11, padding: "7px 10px", outline: "none" }}
                            />
                            <button onClick={clearSearch} style={{ padding: "7px 10px", background: "rgba(255,100,0,0.1)", border: "1px solid rgba(255,100,0,0.3)", borderRadius: 3, color: "#ff8844", fontFamily: "'Share Tech Mono', monospace", fontSize: 11, cursor: "pointer" }}>✕</button>
                        </div>

                        {/* Filter row */}
                        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                            {/* Country filter */}
                            <select value={filterCountry} onChange={e => { setFilterCountry(e.target.value); runSearch(searchQuery, e.target.value, filterOrbit) }}
                                style={{ flex: 1, background: "rgba(0,10,30,0.9)", border: "1px solid rgba(0,180,255,0.2)", borderRadius: 3, color: "#c8e8ff", fontFamily: "'Share Tech Mono', monospace", fontSize: 10, padding: "5px 8px", outline: "none" }}>
                                <option value="ALL">🌍 All Countries</option>
                                <option value="🇺🇸">🇺🇸 USA</option>
                                <option value="🇨🇳">🇨🇳 China</option>
                                <option value="🇷🇺">🇷🇺 Russia</option>
                                <option value="🇮🇳">🇮🇳 India</option>
                                <option value="🇪🇺">🇪🇺 Europe</option>
                                <option value="🛰️">🛰️ Other</option>
                            </select>
                            {/* Orbit filter */}
                            <select value={filterOrbit} onChange={e => { setFilterOrbit(e.target.value); runSearch(searchQuery, filterCountry, e.target.value) }}
                                style={{ flex: 1, background: "rgba(0,10,30,0.9)", border: "1px solid rgba(0,180,255,0.2)", borderRadius: 3, color: "#c8e8ff", fontFamily: "'Share Tech Mono', monospace", fontSize: 10, padding: "5px 8px", outline: "none" }}>
                                <option value="ALL">All Orbits</option>
                                <option value="LEO">LEO (&lt;2000km)</option>
                                <option value="MEO">MEO (2k–35k km)</option>
                                <option value="GEO">GEO (&gt;35k km)</option>
                            </select>
                        </div>

                        {/* Results */}
                        <div style={{ fontSize: 10, color: "rgba(150,200,255,0.4)", marginBottom: 6 }}>
                            {searchResults.length > 0 ? `${searchResults.length} result${searchResults.length > 1 ? "s" : ""} — click to fly to` : "No matches"}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflowY: "auto" }}>
                            {searchResults.map((sat, i) => (
                                <div key={i} onClick={() => flyToSat(sat)}
                                    style={{ padding: "7px 10px", background: "rgba(0,180,255,0.06)", border: "1px solid rgba(0,180,255,0.15)", borderRadius: 3, cursor: "pointer", transition: "all 0.15s", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,200,255,0.14)")}
                                    onMouseLeave={e => (e.currentTarget.style.background = "rgba(0,180,255,0.06)")}>
                                    <span style={{ fontSize: 11, color: "#c8e8ff" }}>{getCountryFlag(sat.name)} {sat.name.slice(0, 22)}</span>
                                    <span style={{ fontSize: 10, color: "rgba(150,200,255,0.5)" }}>{getOrbitType(sat.alt)} · {sat.alt.toFixed(0)}km</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Space Weather Panel ──────────────────────────────────────────────── */}
            <div className="panel" style={{ position: "fixed", bottom: 90, left: 24, width: 240, padding: "14px 16px", zIndex: 10 }}>
                <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 9, color: "#00ccff", letterSpacing: "2px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>☀ SPACE WEATHER</span>
                    <button onClick={fetchSpaceWeather} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(0,200,255,0.5)", fontSize: 11 }}>↻</button>
                </div>

                {weatherLoading && !spaceWeather ? (
                    <div style={{ fontSize: 11, color: "rgba(0,200,255,0.5)" }}>Loading NOAA data...</div>
                ) : spaceWeather ? (
                    <>
                        {/* Kp storm level banner */}
                        <div style={{ padding: "6px 10px", borderRadius: 3, background: `${spaceWeather.kpColor}18`, border: `1px solid ${spaceWeather.kpColor}44`, textAlign: "center", marginBottom: 8 }}>
                            <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 11, fontWeight: 700, color: spaceWeather.kpColor, letterSpacing: "1px" }}>{spaceWeather.stormLevel}</div>
                        </div>

                        <div className="stat-row">
                            <span className="stat-label">Kp INDEX</span>
                            <span style={{ color: spaceWeather.kpColor, fontWeight: "bold", fontSize: 12 }}>{spaceWeather.kp.toFixed(1)} <span style={{ fontSize: 9 }}>({spaceWeather.kpLabel})</span></span>
                        </div>
                        <div className="stat-row">
                            <span className="stat-label">SOLAR WIND</span>
                            <span className="stat-value">{spaceWeather.solarWind} km/s</span>
                        </div>
                        <div className="stat-row">
                            <span className="stat-label">DENSITY</span>
                            <span className="stat-value">{spaceWeather.density} p/cm³</span>
                        </div>
                        <div className="stat-row">
                            <span className="stat-label">IMF Bz</span>
                            <span style={{ color: spaceWeather.bz < -5 ? "#ff4444" : spaceWeather.bz < 0 ? "#ffaa00" : "#00ff88", fontWeight: "bold", fontSize: 12 }}>
                                {spaceWeather.bz > 0 ? "+" : ""}{spaceWeather.bz} nT
                            </span>
                        </div>
                        <div style={{ fontSize: 9, color: "rgba(150,200,255,0.3)", marginTop: 8 }}>
                            NOAA SWPC · {spaceWeather.lastUpdated}
                        </div>
                    </>
                ) : null}
            </div>

            {/* ── ISS Live Panel ───────────────────────────────────────────────────── */}
            {issData && (
                <div className="panel" style={{
                    position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)",
                    padding: "10px 18px", zIndex: 10, display: "flex", gap: 20, alignItems: "center",
                    border: issData.inEclipse ? "1px solid rgba(80,80,255,0.5)" : "1px solid rgba(255,200,0,0.4)",
                    background: issData.inEclipse ? "rgba(10,10,40,0.92)" : "rgba(20,15,0,0.92)",
                }}>
                    {/* ISS icon pulsing */}
                    <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 11, fontWeight: 700, color: "#ffcc00", letterSpacing: "2px", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 18, animation: "pulse-med 2s infinite" }}>🛸</span>
                        <span>ISS</span>
                    </div>
                    <div style={{ width: 1, height: 28, background: "rgba(255,200,0,0.2)" }} />
                    <div style={{ fontSize: 10, fontFamily: "'Share Tech Mono', monospace", display: "flex", gap: 16, color: "rgba(200,230,255,0.7)" }}>
                        <span><span style={{ color: "rgba(150,200,255,0.4)" }}>ALT </span>{issData.alt.toFixed(1)} km</span>
                        <span><span style={{ color: "rgba(150,200,255,0.4)" }}>LAT </span>{issData.lat.toFixed(2)}°</span>
                        <span><span style={{ color: "rgba(150,200,255,0.4)" }}>LON </span>{issData.lon.toFixed(2)}°</span>
                        <span><span style={{ color: "rgba(150,200,255,0.4)" }}>V </span>{issData.speed} km/s</span>
                    </div>
                    <div style={{ width: 1, height: 28, background: "rgba(255,200,0,0.2)" }} />
                    {/* Eclipse status */}
                    <div style={{
                        padding: "4px 10px", borderRadius: 3,
                        background: issData.inEclipse ? "rgba(30,30,120,0.5)" : "rgba(255,200,0,0.12)",
                        border: `1px solid ${issData.inEclipse ? "rgba(80,80,255,0.4)" : "rgba(255,200,0,0.3)"}`,
                        fontFamily: "'Orbitron', sans-serif", fontSize: 9, fontWeight: 700,
                        color: issData.inEclipse ? "#8888ff" : "#ffcc00", letterSpacing: "1.5px",
                        animation: issData.inEclipse ? "pulse-med 2s infinite" : "none",
                    }}>
                        {issData.inEclipse ? "🌑 ECLIPSE" : "☀ SUNLIT"}
                    </div>
                </div>
            )}

            {/* ── Eclipse Shadow Toggle ─────────────────────────────────────────────── */}
            <div style={{ position: "fixed", bottom: 135, right: 24, zIndex: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <button onClick={toggleEclipseShadow} style={{
                    background: showEclipseShadow ? "rgba(50,50,150,0.2)" : "rgba(0,5,20,0.85)",
                    border: `1px solid ${showEclipseShadow ? "rgba(100,100,255,0.5)" : "rgba(0,180,255,0.15)"}`,
                    borderRadius: 4, padding: "8px 14px", color: showEclipseShadow ? "#aaaaff" : "rgba(150,200,255,0.4)",
                    fontFamily: "'Share Tech Mono', monospace", fontSize: 10, letterSpacing: "1.5px",
                    cursor: "pointer", backdropFilter: "blur(8px)", transition: "all 0.2s",
                }}>
                    {showEclipseShadow ? "🌑 SHADOW ON" : "○ SHADOW OFF"}
                </button>
                <div style={{ fontSize: 9, color: "rgba(150,200,255,0.3)", textAlign: "center", fontFamily: "'Share Tech Mono', monospace" }}>
                    {eclipsedSats.length} sats in eclipse
                </div>
            </div>

            {/* ── Trail Toggle ─────────────────────────────────────────────────────── */}
            <button onClick={toggleTrails} style={{
                position: "fixed", bottom: 90, right: 24, zIndex: 10,
                background: trailsEnabled ? "rgba(0,200,255,0.1)" : "rgba(0,5,20,0.85)",
                border: `1px solid ${trailsEnabled ? "rgba(0,200,255,0.4)" : "rgba(0,180,255,0.15)"}`,
                borderRadius: 4, padding: "8px 14px", color: trailsEnabled ? "#00ffcc" : "rgba(150,200,255,0.4)",
                fontFamily: "'Share Tech Mono', monospace", fontSize: 10, letterSpacing: "1.5px",
                cursor: "pointer", backdropFilter: "blur(8px)", transition: "all 0.2s",
            }}>
                {trailsEnabled ? "✦ TRAILS ON" : "○ TRAILS OFF"}
            </button>

            {/* ── Earth Re-center Button ───────────────────────────────────────────── */}
            {selectedSat && (
                <button onClick={centerOnEarth} style={{
                    position: "fixed", bottom: 70, left: "50%", transform: "translateX(-50%)",
                    background: "rgba(0,5,20,0.9)", border: "1px solid rgba(0,180,255,0.3)",
                    borderRadius: 4, padding: "8px 20px", color: "#00ccff",
                    fontFamily: "'Share Tech Mono', monospace", fontSize: 11,
                    letterSpacing: "2px", cursor: "pointer", zIndex: 10,
                    backdropFilter: "blur(8px)", transition: "all 0.2s",
                }}
                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,180,255,0.15)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "rgba(0,5,20,0.9)")}
                >
                    ⊕ CENTER ON EARTH
                </button>
            )}

            {/* ── Bottom Status Bar ────────────────────────────────────────────────── */}
            <div style={{
                position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
                display: "flex", gap: 24, alignItems: "center",
                background: "rgba(0,5,20,0.85)", border: "1px solid rgba(0,180,255,0.15)",
                borderRadius: 4, padding: "8px 24px", backdropFilter: "blur(8px)",
                fontFamily: "'Share Tech Mono', monospace", fontSize: 11,
                color: "rgba(150,200,255,0.5)", zIndex: 10,
            }}>
                <span>
                    <span style={{ color: "#4488ff" }}>■</span> US &nbsp;
                    <span style={{ color: "#ff3333" }}>■</span> CN &nbsp;
                    <span style={{ color: "#ffcc00" }}>■</span> RU &nbsp;
                    <span style={{ color: "#ff8800" }}>■</span> IN &nbsp;
                    <span style={{ color: "#22cc66" }}>■</span> EU
                </span>
                <span style={{ color: "rgba(0,180,255,0.3)" }}>|</span>
                <span>
                    <span style={{ color: "#00ffff" }}>— LEO</span> &nbsp;
                    <span style={{ color: "#ffff00" }}>— MEO</span> &nbsp;
                    <span style={{ color: "#ff4400" }}>— GEO</span>
                </span>
                <span style={{ color: "rgba(0,180,255,0.3)" }}>|</span>
                <span>{solarVisible ? "🌌 HELIOCENTRIC" : paused ? "⏸ PAUSED" : "▶ LIVE"}</span>
                {spaceWeather && spaceWeather.kp >= 5 && (
                    <>
                        <span style={{ color: "rgba(0,180,255,0.3)" }}>|</span>
                        <span style={{ color: "#ffaa00", animation: "pulse-med 2s infinite" }}>☀ STORM Kp{spaceWeather.kp.toFixed(0)}</span>
                    </>
                )}
            </div>
        </>
    )
}