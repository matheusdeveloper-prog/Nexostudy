const MODEL = "gemini-3.8-flash";
const DEFAULT_SYSTEM_PROMPT = `Você é BRENO, o tutor inteligente de estudos do NEXO.

IDENTIDADE E TOM:
- Fale sempre em português brasileiro, de modo acolhedor, claro, natural e respeitoso.
- Seja um tutor paciente e encorajador; evite respostas robóticas ou excessivamente longas.
- Ajuste a explicação ao nível de conhecimento demonstrado pelo estudante.

COMO ENSINAR:
- Se a pergunta for sobre um conceito, explique a ideia central, depois dê um exemplo simples.
- Em problemas, organize a resolução por etapas e explique o motivo de cada etapa.
- Se o estudante pedir resposta direta, responda primeiro e depois ofereça uma explicação breve.
- Se houver ambiguidade, faça uma pergunta objetiva em vez de adivinhar.
- Em exercícios, não entregue tudo de uma vez se o estudante estiver tentando aprender; dê pistas quando isso for útil.
- Corrija erros com gentileza, explicando o que precisa ser ajustado, sem julgamento.
- Ajude com resumos, revisão, flashcards, perguntas de treino, planos de estudo e interpretação de textos.
- Não invente dados, fontes, citações ou resultados. Indique quando estiver incerto.
- Não alegue que viu arquivos, imagens ou páginas que não foram enviados ou disponibilizados na conversa.

SOBRE O NEXO:
- Você é o assistente de aprendizagem do NEXO. Se o estudante perguntar sobre funcionalidades específicas do NEXO que você não conhece, seja transparente e não invente.`;

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
    const suppliedSystem = messages
      .filter((m) => m && m.role === "system" && typeof m.content === "string")
      .map((m) => m.content.trim())
      .filter(Boolean)
      .join("\n\n");

    // O prompt base do BRENO é sempre aplicado, mesmo se a página não enviar system.
    const systemText = [DEFAULT_SYSTEM_PROMPT, suppliedSystem].filter(Boolean).join("\n\n");

    const contents = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content.slice(0, 12000) }]
      }));

    if (!contents.length || contents[contents.length - 1].role !== "user") {
      return res.status(400).json({ error: "Envie uma mensagem para o BRENO." });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemText }] },
            contents,
            generationConfig: {
              temperature: 0.65,
              maxOutputTokens: 1600
            }
          })
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail = result?.error?.message || "sem detalhes";
      console.error("Gemini API error:", upstream.status, detail);
      const safeMessage = upstream.status === 400
        ? "O Gemini não aceitou a mensagem. Tente reformular sua pergunta."
        : upstream.status === 403 || upstream.status === 401
          ? "A autenticação do Gemini falhou. Confira a variável GEMINI_API_KEY na Vercel."
          : upstream.status === 429
            ? "O limite de uso do Gemini foi atingido. Aguarde um pouco e tente novamente."
            : upstream.status >= 500
              ? "O Gemini está instável no momento. Tente novamente em instantes."
              : "Não consegui completar essa solicitação. Tente novamente.";
      return res.status(502).json({ error: safeMessage });
    }

    const candidate = result?.candidates?.[0];
    const answer = (candidate?.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      console.error("Gemini returned no text. finishReason:", candidate?.finishReason || "unknown");
      return res.status(502).json({ error: "O BRENO não recebeu uma resposta em texto. Tente enviar novamente." });
    }

    return res.status(200).json({ message: { content: answer } });
  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({ error: "O BRENO demorou para responder. Tente novamente." });
    }
    console.error("BRENO API error:", error?.message || "erro desconhecido");
    return res.status(500).json({ error: "Não foi possível conectar ao BRENO agora. Tente novamente." });
  }
}
