export default {
    async fetch(request, env, ctx) {
        const requestOrigin = request.headers.get("Origin");
        const corsHeaders = {
            // Echo the caller's origin when provided; fall back to * for file:// or tools
            "Access-Control-Allow-Origin": requestOrigin || "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
            "Vary": "Origin",
        };
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405, headers: corsHeaders });
        }

        try {
            const { prompt } = await request.json();
            if (!prompt || typeof prompt !== "string") {
                return new Response(JSON.stringify({ error: "Missing prompt" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }

            // Rate limit per IP
            const ip = request.headers.get("cf-connecting-ip") || "anon";
            const minuteKey = `m:${ip}:${new Date().toISOString().slice(0, 16)}`; // minute bucket
            const dayKey = `d:${ip}:${new Date().toISOString().slice(0, 10)}`; // day bucket
            const minuteLimit = Number(env.MINUTE_LIMIT ?? 3);
            const dailyLimit = Number(env.DAILY_LIMIT ?? 20);

            const minuteCount = Number((await env.RATE_LIMIT.get(minuteKey)) || 0);
            const dayCount = Number((await env.RATE_LIMIT.get(dayKey)) || 0);
            if (minuteCount >= minuteLimit || dayCount >= dailyLimit) {
                return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            // Increment counters
            ctx.waitUntil(env.RATE_LIMIT.put(minuteKey, String(minuteCount + 1), { expirationTtl: 90 }));
            ctx.waitUntil(env.RATE_LIMIT.put(dayKey, String(dayCount + 1), { expirationTtl: 60 * 60 * 24 + 60 }));

            const model = env.MODEL || "gemini-2.0-flash";
            const apiKey = env.GEMINI_API_KEY;
            if (!apiKey) {
                return new Response(JSON.stringify({ error: "Server not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }

            const systemText = env.SYSTEM_PROMPT || "Return only the email text. Draft the message TO Caleb Carhart (recipient), not from him. Optional 'Subject:' then body. Keep under 120 words, friendly, one ask, simple sign-off. No meta/markdown.";
            const body = {
                systemInstruction: { role: "system", parts: [{ text: systemText }] },
                contents: [
                    { role: "user", parts: [{ text: prompt }] }
                ],
                generationConfig: { responseMimeType: "text/plain" }
            };

            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            let text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "Sorry, could not generate a draft right now.";
            // Simple post-sanitize: strip code fences if any slipped through
            text = text.replace(/```[\s\S]*?```/g, "").trim();
            return new Response(JSON.stringify({ draft: text }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } catch (e) {
            return new Response(JSON.stringify({ error: "Bad request" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
    },
};


