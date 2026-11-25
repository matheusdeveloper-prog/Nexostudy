const MODEL = "gemini-3.8-flash";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "A chave GEMINI_API_KEY não está configurada na Vercel." });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: "Formato de conversa inválido." });
    }

    const messages = body.messages.slice(-14);
    const systemText = messages
      .filter((m) => m && m.role === "system" && typeof m.content === "string")
      .map((m) => m.content)
      .join("\n\n");

    const contents = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content.slice(0, 12000) }]
      }));

    if (!contents.length || contents[contents.length - 1].role !== "user") {
      return res.status(400).json({ error: "Envie uma mensagem para o BRENO." });
    }

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
        })
      }
    );

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = result?.error?.message;
      const safeMessage = upstream.status === 400
        ? "O Gemini recusou o formato da mensagem. Tente novamente."
        : upstream.status === 403 || upstream.status === 401
          ? "A chave do Gemini foi recusada. Confira GEMINI_API_KEY nas variáveis da Vercel."
          : upstream.status === 429
            ? "O limite de uso do Gemini foi atingido. Aguarde um pouco e tente novamente."
            : "O serviço Gemini está temporariamente indisponível.";
      console.error("Gemini API error:", upstream.status, message || "sem detalhes");
      return res.status(502).json({ error: safeMessage });
    }

    const answer = (result?.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      return res.status(502).json({ error: "O Gemini retornou uma resposta vazia. Tente novamente." });
    }

    return res.status(200).json({ message: { content: answer } });
  } catch (error) {
    console.error("BRENO API error:", error?.message || "erro desconhecido");
    return res.status(500).json({ error: "Não foi possível conectar ao Gemini agora. Tente novamente." });
  }
}
