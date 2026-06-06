import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerSmartTools(server: McpServer, clover: CloverClient) {

  // ── DAILY BRIEFING ──────────────────────────────────────────────────────────
  server.tool(
    "daily_briefing",
    `Call this every morning or when the owner asks how yesterday went. Returns yesterday's revenue, top sellers, low stock alerts, open orders, and a week-over-week revenue comparison — all in one shot. Supports multilingual output via the language param (e.g. 'vi' for Vietnamese, 'ko' for Korean, 'es' for Spanish).`,
    {
      language: z.string().optional().describe("BCP-47 language code for the response (e.g. 'vi', 'ko', 'es'). Defaults to English."),
    },
    async ({ language }) => {
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const start = new Date(yesterday.setHours(0, 0, 0, 0)).getTime();
      const end = new Date(yesterday.setHours(23, 59, 59, 999)).getTime();
      const sameDay7Ago = start - 7 * 24 * 60 * 60 * 1000;
      const sameDay7AgoEnd = end - 7 * 24 * 60 * 60 * 1000;

      const [orders, lastWeekOrders, stocks, openOrders] = await Promise.all([
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${start}`, `createdTime<=${end}`, "paymentState=PAID"],
          expand: "lineItems,payments",
          limit: 500,
        }),
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${sameDay7Ago}`, `createdTime<=${sameDay7AgoEnd}`, "paymentState=PAID"],
          limit: 500,
        }),
        clover.get<any>(clover.v3("/item_stocks"), { expand: "item", limit: 200 }),
        clover.get<any>(clover.v3("/orders"), { filter: "paymentState=OPEN", limit: 20 }),
      ]);

      const elements = orders.elements ?? [];
      const totalRevenueCents = elements.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const lastWeekRevenueCents = (lastWeekOrders.elements ?? []).reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const revChange = lastWeekRevenueCents > 0
        ? (((totalRevenueCents - lastWeekRevenueCents) / lastWeekRevenueCents) * 100).toFixed(1)
        : null;

      const tipsCents = elements.reduce((s: number, o: any) =>
        s + (o.payments?.elements ?? []).reduce((t: number, p: any) => t + (p.tipAmount ?? 0), 0), 0);

      const itemSales: Record<string, { name: string; qty: number }> = {};
      for (const order of elements) {
        for (const li of order.lineItems?.elements ?? []) {
          const k = li.name ?? "unknown";
          if (!itemSales[k]) itemSales[k] = { name: k, qty: 0 };
          itemSales[k].qty++;
        }
      }
      const topItems = Object.values(itemSales).sort((a, b) => b.qty - a.qty).slice(0, 5);
      const lowStock = (stocks.elements ?? [])
        .filter((s: any) => s.quantity !== undefined && s.quantity <= 5)
        .map((s: any) => ({ name: s.item?.name, quantity: s.quantity, unit: s.unit ?? "units" }));

      const result: Record<string, any> = {
        date: new Date(start).toDateString(),
        revenue: `$${(totalRevenueCents / 100).toFixed(2)}`,
        revenueVsLastWeek: revChange !== null ? `${Number(revChange) >= 0 ? "+" : ""}${revChange}%` : "N/A",
        totalOrders: elements.length,
        avgCheck: elements.length > 0 ? `$${(totalRevenueCents / elements.length / 100).toFixed(2)}` : "$0.00",
        totalTips: `$${(tipsCents / 100).toFixed(2)}`,
        topSellers: topItems,
        lowStockAlerts: lowStock,
        openOrders: openOrders.elements?.length ?? 0,
      };

      if (language && language !== "en") {
        result._language_directive = `Present this briefing to the user in the language with BCP-47 code: ${language}. Translate all labels and narrative naturally — do not leave any English.`;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── CATERING QUOTE ──────────────────────────────────────────────────────────
  server.tool(
    "generate_catering_quote",
    "Generate a catering estimate for a party. Pulls live menu prices and calculates totals with optional markup.",
    {
      partySize: z.number().describe("Number of guests"),
      itemSelections: z.array(z.object({
        itemName: z.string().describe("Menu item name (partial match ok)"),
        quantity: z.number().describe("Number of orders"),
      })).describe("List of items and quantities"),
      markupPercent: z.number().optional().default(15).describe("Catering markup percentage"),
      eventDate: z.string().optional().describe("Event date for the quote header"),
      clientName: z.string().optional().describe("Client name for the quote"),
    },
    async ({ partySize, itemSelections, markupPercent, eventDate, clientName }) => {
      const menu = await clover.get<any>(clover.v3("/items"), { limit: 200 });
      const items = menu.elements ?? [];

      const lineItems = itemSelections.map(sel => {
        const match = items.find((i: any) =>
          i.name?.toLowerCase().includes(sel.itemName.toLowerCase())
        );
        const unitPrice = match?.price ?? 0;
        const subtotal = unitPrice * sel.quantity;
        return {
          item: match?.name ?? sel.itemName,
          unitPrice: `$${(unitPrice / 100).toFixed(2)}`,
          quantity: sel.quantity,
          subtotal: `$${(subtotal / 100).toFixed(2)}`,
          subtotalCents: subtotal,
        };
      });

      const subtotalCents = lineItems.reduce((s, l) => s + l.subtotalCents, 0);
      const markupCents = Math.round(subtotalCents * markupPercent / 100);
      const totalCents = subtotalCents + markupCents;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            quote: {
              client: clientName ?? "TBD",
              eventDate: eventDate ?? "TBD",
              partySize,
              lineItems,
              subtotal: `$${(subtotalCents / 100).toFixed(2)}`,
              cateringMarkup: `${markupPercent}% — $${(markupCents / 100).toFixed(2)}`,
              total: `$${(totalCents / 100).toFixed(2)}`,
              perPerson: `$${(totalCents / partySize / 100).toFixed(2)}`,
            },
          }, null, 2),
        }],
      };
    }
  );

  // ── SHIFT SUMMARY ───────────────────────────────────────────────────────────
  server.tool(
    "end_of_shift_summary",
    "End-of-shift report: total covers, revenue, top items, average check. Great for texting to the owner after close.",
    {
      shiftStart: z.string().describe("ISO datetime when the shift started"),
      shiftEnd: z.string().optional().describe("ISO datetime when the shift ended. Defaults to now."),
    },
    async ({ shiftStart, shiftEnd }) => {
      const start = new Date(shiftStart).getTime();
      const end = shiftEnd ? new Date(shiftEnd).getTime() : Date.now();

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start}`, `createdTime<=${end}`, "paymentState=PAID"],
        expand: "lineItems,payments",
        limit: 300,
      });

      const elements = orders.elements ?? [];
      const revenueCents = elements.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const tipsCents = elements.reduce((s: number, o: any) => {
        return s + (o.payments?.elements ?? []).reduce((t: number, p: any) => t + (p.tipAmount ?? 0), 0);
      }, 0);

      const itemSales: Record<string, number> = {};
      for (const order of elements) {
        for (const li of order.lineItems?.elements ?? []) {
          const k = li.name ?? "unknown";
          itemSales[k] = (itemSales[k] ?? 0) + 1;
        }
      }
      const topItems = Object.entries(itemSales)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([name, qty]) => ({ name, qty }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            shiftRevenue: `$${(revenueCents / 100).toFixed(2)}`,
            totalOrders: elements.length,
            avgCheck: elements.length > 0
              ? `$${(revenueCents / elements.length / 100).toFixed(2)}`
              : "$0.00",
            totalTips: `$${(tipsCents / 100).toFixed(2)}`,
            topSellers: topItems,
          }, null, 2),
        }],
      };
    }
  );

  // ── MENU OPTIMIZATION ───────────────────────────────────────────────────────
  server.tool(
    "menu_optimization_report",
    "Identify underperforming items (low sales + low margin). Suggests what to push, price-adjust, or consider removing. Uses last 30 days of data.",
    {},
    async () => {
      const start = new Date(); start.setDate(start.getDate() - 30);

      const [orders, menu] = await Promise.all([
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${start.getTime()}`, "paymentState=PAID"],
          expand: "lineItems",
          limit: 500,
        }),
        clover.get<any>(clover.v3("/items"), { limit: 200 }),
      ]);

      const itemSales: Record<string, { name: string; qty: number; revenueCents: number; priceCents: number }> = {};
      for (const item of menu.elements ?? []) {
        itemSales[item.id] = { name: item.name, qty: 0, revenueCents: 0, priceCents: item.price ?? 0 };
      }

      for (const order of orders.elements ?? []) {
        for (const li of order.lineItems?.elements ?? []) {
          const id = li.item?.id;
          if (id && itemSales[id]) {
            itemSales[id].qty++;
            itemSales[id].revenueCents += li.price ?? 0;
          }
        }
      }

      const all = Object.values(itemSales);
      const avgQty = all.reduce((s, i) => s + i.qty, 0) / (all.length || 1);

      const stars = all.filter(i => i.qty > avgQty * 1.5).map(i => ({ name: i.name, tag: "⭐ Push harder", qty: i.qty }));
      const sleepers = all.filter(i => i.qty < avgQty * 0.3 && i.qty > 0).map(i => ({ name: i.name, tag: "😴 Consider repricing or removing", qty: i.qty }));
      const ghosts = all.filter(i => i.qty === 0).map(i => ({ name: i.name, tag: "👻 Zero sales — consider removing" }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ period: "Last 30 days", stars, sleepers, ghosts }, null, 2),
        }],
      };
    }
  );

  // ── DRAFT SUPPLIER MESSAGE ───────────────────────────────────────────────────
  server.tool(
    "draft_supplier_reorder_message",
    "When stock is low, draft a reorder message for a supplier. Returns a ready-to-send WhatsApp/text message.",
    {
      items: z.array(z.object({
        name: z.string(),
        currentQty: z.number(),
        orderQty: z.number().describe("Suggested order quantity"),
        unit: z.string().optional().default("units"),
      })),
      supplierName: z.string().optional().default("Supplier"),
      restaurantName: z.string().optional().default("the restaurant"),
    },
    async ({ items, supplierName, restaurantName }) => {
      const lines = items.map(i => `- ${i.name}: ${i.orderQty} ${i.unit}`).join("\n");
      const message = `Hi ${supplierName},\n\nThis is ${restaurantName}. We need to place a reorder:\n\n${lines}\n\nPlease confirm availability and delivery date. Thank you!`;
      return { content: [{ type: "text", text: message }] };
    }
  );

  // ── SLOW DAY ANALYSIS ───────────────────────────────────────────────────────
  server.tool(
    "get_slow_day_analysis",
    `Call this when the owner says it's slow, asks why business is down, or wonders how today compares to normal. Compares today's revenue so far against the same time window last week and a 4-week average for this day of the week. Returns a plain-language verdict so the owner can act on it immediately.`,
    {
      language: z.string().optional().describe("BCP-47 language code (e.g. 'vi', 'ko', 'es'). Defaults to English."),
    },
    async ({ language }) => {
      const now = Date.now();
      const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
      const todayStart = todayMidnight.getTime();

      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      const elapsed = now - todayStart;

      const [todayOrders, wk1Orders, wk2Orders, wk3Orders, wk4Orders] = await Promise.all([
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart}`, `createdTime<=${now}`, "paymentState=PAID"],
          limit: 500,
        }),
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart - oneWeek}`, `createdTime<=${now - oneWeek}`, "paymentState=PAID"],
          limit: 500,
        }),
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart - 2 * oneWeek}`, `createdTime<=${now - 2 * oneWeek}`, "paymentState=PAID"],
          limit: 500,
        }),
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart - 3 * oneWeek}`, `createdTime<=${now - 3 * oneWeek}`, "paymentState=PAID"],
          limit: 500,
        }),
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart - 4 * oneWeek}`, `createdTime<=${now - 4 * oneWeek}`, "paymentState=PAID"],
          limit: 500,
        }),
      ]);

      const rev = (orders: any) => (orders.elements ?? []).reduce((s: number, o: any) => s + (o.total ?? 0), 0);

      const todayRev = rev(todayOrders);
      const lastWeekRev = rev(wk1Orders);
      const avgRev = Math.round((rev(wk1Orders) + rev(wk2Orders) + rev(wk3Orders) + rev(wk4Orders)) / 4);

      const vsLastWeek = lastWeekRev > 0 ? (((todayRev - lastWeekRev) / lastWeekRev) * 100).toFixed(1) : null;
      const vsAvg = avgRev > 0 ? (((todayRev - avgRev) / avgRev) * 100).toFixed(1) : null;

      const dayName = new Date().toLocaleDateString("en-US", { weekday: "long" });
      const timeStr = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

      let verdict = "On track.";
      if (vsAvg !== null && Number(vsAvg) < -20) verdict = "Significantly below average — consider a promotion or check if there's an event nearby pulling foot traffic.";
      else if (vsAvg !== null && Number(vsAvg) < -10) verdict = "Slightly below average — could pick up later in the day.";
      else if (vsAvg !== null && Number(vsAvg) > 15) verdict = "Strong day — above your typical average for this time.";

      const result: Record<string, any> = {
        snapshot: `${dayName} as of ${timeStr}`,
        revenueToNow: `$${(todayRev / 100).toFixed(2)}`,
        vsLastWeek: vsLastWeek !== null ? `${Number(vsLastWeek) >= 0 ? "+" : ""}${vsLastWeek}%` : "N/A",
        vs4WeekAvg: vsAvg !== null ? `${Number(vsAvg) >= 0 ? "+" : ""}${vsAvg}%` : "N/A",
        ordersToNow: todayOrders.elements?.length ?? 0,
        verdict,
      };

      if (language && language !== "en") {
        result._language_directive = `Present this analysis to the user in the language with BCP-47 code: ${language}. Translate naturally.`;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── SUGGEST 86 CANDIDATES ────────────────────────────────────────────────────
  server.tool(
    "suggest_86_candidates",
    `Call this when the owner wants to reduce waste, simplify the menu, or do weekly inventory cleanup. Finds items that are both low in stock AND moving slowly — the worst of both worlds. These are the items worth 86-ing rather than reordering. Returns a prioritized list with a waste-risk score.`,
    {},
    async () => {
      const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

      const [stocks, orders] = await Promise.all([
        clover.get<any>(clover.v3("/item_stocks"), { expand: "item", limit: 200 }),
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${fourteenDaysAgo}`, "paymentState=PAID"],
          expand: "lineItems",
          limit: 500,
        }),
      ]);

      const salesVelocity: Record<string, number> = {};
      for (const order of orders.elements ?? []) {
        for (const li of order.lineItems?.elements ?? []) {
          const id = li.item?.id;
          if (id) salesVelocity[id] = (salesVelocity[id] ?? 0) + 1;
        }
      }

      const candidates = (stocks.elements ?? [])
        .filter((s: any) => s.quantity !== undefined && s.quantity > 0 && s.quantity <= 15 && s.item?.id)
        .map((s: any) => {
          const velocity = (salesVelocity[s.item.id] ?? 0) / 14;
          const daysUntilOut = velocity > 0 ? (s.quantity / velocity) : 999;
          return {
            itemId: s.item.id,
            name: s.item.name,
            stock: s.quantity,
            salesLast14Days: salesVelocity[s.item.id] ?? 0,
            dailyVelocity: parseFloat(velocity.toFixed(2)),
            daysOfStockLeft: daysUntilOut < 999 ? Math.round(daysUntilOut) : "stagnant",
            recommendation: velocity < 0.3 && s.quantity <= 10
              ? "🔴 86 it — low stock, barely selling"
              : velocity < 0.5
              ? "🟡 Monitor — slow mover, don't reorder aggressively"
              : "🟢 Worth reordering",
          };
        })
        .sort((a: any, b: any) => {
          const score = (i: any) => (i.recommendation.startsWith("🔴") ? 0 : i.recommendation.startsWith("🟡") ? 1 : 2);
          return score(a) - score(b);
        });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: "Last 14 days",
            candidates,
            tip: "Items marked 🔴 are the best candidates to 86 — they'll go to waste before they sell.",
          }, null, 2),
        }],
      };
    }
  );

  // ── WASTE LOG ───────────────────────────────────────────────────────────────
  server.tool(
    "log_waste",
    "Log food waste for cost tracking. Adjusts inventory down and records the loss.",
    {
      items: z.array(z.object({
        itemId: z.string(),
        quantity: z.number(),
        reason: z.string().optional().describe("e.g. 'expired', 'dropped', 'overcooked'"),
      })),
    },
    async ({ items }) => {
      const results = await Promise.all(
        items.map(async (item) => {
          const current = await clover.get<any>(clover.v3(`/item_stocks/${item.itemId}`));
          const newQty = Math.max(0, (current.quantity ?? 0) - item.quantity);
          await clover.post<any>(clover.v3(`/item_stocks/${item.itemId}`), { quantity: newQty });
          return { itemId: item.itemId, wasted: item.quantity, reason: item.reason ?? "unspecified", newStock: newQty };
        })
      );
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );
}
