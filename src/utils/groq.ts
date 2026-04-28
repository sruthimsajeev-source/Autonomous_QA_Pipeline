import { z } from "zod";

const GroqResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string()
      })
    })
  )
});

export class GroqClient {
  constructor(
    private readonly apiKey: string,
    private readonly model = "llama-3.3-70b-versatile"
  ) {}

  async complete(prompt: string, systemPrompt?: string, maxTokens = 8192): Promise<string> {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        max_tokens: maxTokens,
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: prompt }
        ]
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Groq API failed (${res.status}): ${text}`);
    }

    const json = GroqResponseSchema.parse(await res.json());
    return json.choices[0]?.message.content ?? "";
  }
}
