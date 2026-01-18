// new features: auto-deletion, auto-split

export default {
  async fetch(request, env) {
    try {
      // === CONFIG ===
      const NOTION_TOKEN = env.NOTION_TOKEN;
      const NOTION_VERSION = "2025-09-03";
      const PAGE_ID = "2ea6b44222f2803cb41af259bea472c2";
      const MAX_PAYLOAD = 1800;

      const url = new URL(request.url);
      const path = url.pathname;

      const headers = {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      };

      // === READ ALL BLOCKS ===
      if (path === "/read" && request.method === "GET") {
        const notionRes = await fetch(
          `https://api.notion.com/v1/blocks/${PAGE_ID}/children?page_size=100`,
          { headers }
        );
        const data = await notionRes.json();
        return new Response(JSON.stringify(data, null, 2), {
          headers: { "Content-Type": "application/json" },
          status: notionRes.status,
        });
      }

      // === APPEND SINGLE BLOCK ===
      if (path === "/append" && request.method === "POST") {
        const body = await request.json();
        const block = body.block || {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: body.text || "" } }],
          },
        };

        const payload = JSON.stringify({ children: [block] });
        if (payload.length > MAX_PAYLOAD) {
          return new Response(
            JSON.stringify({
              error: "Payload too large for /append",
              length: payload.length,
            }),
            { status: 400 }
          );
        }

        const notionRes = await fetch(
          `https://api.notion.com/v1/blocks/${PAGE_ID}/children`,
          {
            method: "PATCH",
            headers,
            body: payload,
          }
        );
        const data = await notionRes.json();
        return new Response(JSON.stringify(data, null, 2), {
          headers: { "Content-Type": "application/json" },
          status: notionRes.status,
        });
      }

      // === DELETE SINGLE BLOCK ===
      if (path === "/delete" && request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id)
          return new Response("Missing block ID", { status: 400 });

        const cleanId = id.replace(/-/g, "");
        if (!/^[a-f0-9]{32}$/i.test(cleanId)) {
          return new Response(
            JSON.stringify({
              error: "Invalid Notion block ID format.",
              provided: id,
            }),
            { status: 400 }
          );
        }

        // Check if block exists before deletion
        const check = await fetch(`https://api.notion.com/v1/blocks/${cleanId}`, { headers });
        if (check.status === 404) {
          return new Response(
            JSON.stringify({
              note: "Block already deleted or not found",
              id: cleanId,
            }),
            { status: 200 }
          );
        }

        const notionRes = await fetch(
          `https://api.notion.com/v1/blocks/${cleanId}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ archived: true }),
          }
        );
        const data = await notionRes.text();

        // If already archived, treat as success
        if (data.includes("Can't edit block that is archived")) {
          return new Response(
            JSON.stringify({
              note: "Block was already archived, skipped",
              id: cleanId,
            }),
            { status: 200 }
          );
        }

        return new Response(data, {
          headers: { "Content-Type": "application/json" },
          status: notionRes.status,
        });
      }

      // === EXECUTE MULTI-ACTION PLAN ===
      if (path === "/execute" && request.method === "POST") {
        const { actions = [] } = await request.json();
        const results = { executed: [], errors: [] };

        // Helper: idempotent deleteBlock
        const deleteBlock = async (blockId) => {
          try {
            const cleanId = blockId.replace(/-/g, "");
            if (!/^[a-f0-9]{32}$/i.test(cleanId)) {
              results.errors.push({
                op: "delete",
                id: blockId,
                error: "Invalid Notion block ID",
              });
              return;
            }

            const check = await fetch(`https://api.notion.com/v1/blocks/${cleanId}`, { headers });
            if (check.status === 404) {
              results.executed.push({
                op: "delete",
                id: cleanId,
                note: "Block already deleted or not found",
              });
              return;
            }

            const res = await fetch(`https://api.notion.com/v1/blocks/${cleanId}`, {
              method: "PATCH",
              headers,
              body: JSON.stringify({ archived: true }),
            });

            const text = await res.text();
            if (res.ok) {
              results.executed.push({
                op: "delete",
                id: cleanId,
                status: res.status,
              });
            } else if (text.includes("Can't edit block that is archived")) {
              results.executed.push({
                op: "delete",
                id: cleanId,
                note: "Block was already archived, skipped",
              });
            } else {
              results.errors.push({
                op: "delete",
                id: cleanId,
                status: res.status,
                response: text,
              });
            }
          } catch (err) {
            results.errors.push({
              op: "delete",
              id: blockId,
              error: err.message,
            });
          }
        };

        // Helper: appendBlock with auto-splitting
        const appendBlock = async (block) => {
          try {
            const content =
              block.paragraph?.rich_text?.[0]?.text?.content ||
              block.heading_3?.rich_text?.[0]?.text?.content ||
              block.text ||
              "";

            // Auto-split large text
            if (content.length > MAX_PAYLOAD) {
              const parts = [];
              for (let i = 0; i < content.length; i += MAX_PAYLOAD) {
                const slice = content.slice(i, i + MAX_PAYLOAD);
                parts.push({
                  preview: slice.substring(0, 50),
                  block: {
                    object: "block",
                    type: "paragraph",
                    paragraph: {
                      rich_text: [{ type: "text", text: { content: slice } }],
                    },
                  },
                });
              }

              for (const part of parts) {
                const payload = JSON.stringify({ children: [part.block] });
                const res = await fetch(
                  `https://api.notion.com/v1/blocks/${PAGE_ID}/children`,
                  {
                    method: "PATCH",
                    headers,
                    body: payload,
                  }
                );
                const data = await res.json();
                if (res.ok) {
                  results.executed.push({
                    op: "append",
                    text: part.preview + "...",
                    id: data.results?.[0]?.id || null,
                    status: res.status,
                  });
                } else {
                  results.errors.push({
                    op: "append",
                    text: part.preview + "...",
                    status: res.status,
                  });
                }
              }
              return;
            }

            // Regular append
            const payload = JSON.stringify({ children: [block] });
            const res = await fetch(
              `https://api.notion.com/v1/blocks/${PAGE_ID}/children`,
              {
                method: "PATCH",
                headers,
                body: payload,
              }
            );
            const data = await res.json();
            if (res.ok) {
              results.executed.push({
                op: "append",
                text:
                  block.text ||
                  block.heading_3?.rich_text?.[0]?.text?.content ||
                  "(no text)",
                id: data.results?.[0]?.id || null,
                status: res.status,
              });
            } else {
              results.errors.push({
                op: "append",
                text: block.text || "(no text)",
                status: res.status,
              });
            }
          } catch (err) {
            results.errors.push({ op: "append", error: err.message });
          }
        };

        // Sequentially run each action
        for (const a of actions) {
          if (a.op === "delete" && a.id) await deleteBlock(a.id);
          else if (a.op === "append" && a.block) await appendBlock(a.block);
        }

        return new Response(JSON.stringify(results, null, 2), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }

      // === FALLBACK ===
      return new Response(
        JSON.stringify({ error: "Endpoint not found" }, null, 2),
        { headers: { "Content-Type": "application/json" }, status: 404 }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || "Unknown error" }, null, 2),
        { headers: { "Content-Type": "application/json" }, status: 500 }
      );
    }
  },
};
