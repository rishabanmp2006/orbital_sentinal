import { NextRequest } from "next/server"

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"

export async function POST(req: NextRequest) {

    // ── 1. Check API key ───────────────────────────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
        console.error("SENTINEL-AI: GEMINI_API_KEY is not set in .env.local")
        return Response.json(
            { error: "API key not configured. Add GEMINI_API_KEY to .env.local" },
            { status: 500 }
        )
    }

    // ── 2. Parse body ──────────────────────────────────────────────────────────
    let body: any
    try {
        body = await req.json()
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const {
        mode,
        conjunctions = [],
        globalRisk = "safe",
        satCount = 0,
        selectedSat,
        question,
        chatHistory = [],
    } = body

    if (!mode) {
        return Response.json({ error: "Missing 'mode' field" }, { status: 400 })
    }

    // ── 3. System prompt ───────────────────────────────────────────────────────
    const systemPrompt = `You are SENTINEL-AI, an advanced space situational awareness system integrated into the Orbital Sentinel dashboard. You monitor real satellite conjunction data and assess collision risks.

Your role:
- Analyze live conjunction events (close approaches between satellites)
- Provide concise, expert threat assessments in plain English
- Answer questions about orbital mechanics, specific satellites, and space safety
- Be direct and technical but understandable — like a real mission controller

Current orbital environment:
- Satellites tracked: ${satCount}
- Global risk status: ${globalRisk.toUpperCase()}
- Active conjunctions: ${conjunctions.length}
${conjunctions.length > 0
            ? `- Top threats:\n${conjunctions.slice(0, 5).map((c: any, i: number) =>
                `  ${i + 1}. ${c.satA} ↔ ${c.satB} | ${c.risk.toUpperCase()} RISK | ${c.distance}m separation`
            ).join("\n")}`
            : "- No active conjunctions"
        }
${selectedSat ? `- Currently selected satellite: ${selectedSat.name} at ${selectedSat.alt?.toFixed(0)}km (${selectedSat.orbitType})` : ""}

Keep responses short and sharp — 2-4 sentences max for narrations, up to 6 for Q&A. No markdown headers or bullet points. Use technical language naturally.`

    // ── 4. Build Gemini request ────────────────────────────────────────────────
    try {
        let contents: any[] = []

        if (mode === "narrate") {
            const userMsg = conjunctions.length === 0
                ? "Give a brief all-clear status report for the current orbital environment."
                : "Provide a threat briefing for the current orbital situation. Focus on the most dangerous conjunction events detected."

            contents = [{ role: "user", parts: [{ text: userMsg }] }]

        } else if (mode === "chat") {
            if (!question) {
                return Response.json({ error: "Missing 'question' for chat mode" }, { status: 400 })
            }

            // Convert chat history to Gemini format (alternating user/model)
            const history = (chatHistory || []).slice(-8)
            for (const msg of history) {
                contents.push({
                    role: msg.role === "assistant" ? "model" : "user",
                    parts: [{ text: msg.content }],
                })
            }

            contents.push({ role: "user", parts: [{ text: question }] })

        } else {
            return Response.json({ error: `Unknown mode: ${mode}` }, { status: 400 })
        }

        // ── 5. Call Gemini API ───────────────────────────────────────────────────
        const geminiResponse = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                system_instruction: {
                    parts: [{ text: systemPrompt }],
                },
                contents,
                generationConfig: {
                    maxOutputTokens: mode === "narrate" ? 200 : 350,
                    temperature: 0.7,
                },
            }),
        })

        if (!geminiResponse.ok) {
            const errData = await geminiResponse.json()
            console.error("Gemini API error:", errData)
            const msg = errData?.error?.message || "Unknown Gemini API error"
            return Response.json({ error: `Gemini error: ${msg}` }, { status: geminiResponse.status })
        }

        const geminiData = await geminiResponse.json()

        // Extract text from Gemini response
        const text = geminiData?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p.text || "")
            .join("") || ""

        if (!text) {
            console.error("Empty Gemini response:", JSON.stringify(geminiData))
            return Response.json({ error: "Empty response from Gemini" }, { status: 500 })
        }

        return Response.json({ text })

    } catch (err: any) {
        console.error("SENTINEL-AI route error:", err.message)
        return Response.json({ error: `Server error: ${err.message}` }, { status: 500 })
    }
}

// ── Health check ─────────────────────────────────────────────────────────────
export async function GET() {
    const hasKey = !!process.env.GEMINI_API_KEY
    return Response.json({
        status: hasKey ? "ready" : "missing_api_key",
        provider: "Google Gemini 1.5 Flash",
        keyPrefix: hasKey ? process.env.GEMINI_API_KEY!.slice(0, 8) + "..." : null,
    })
}