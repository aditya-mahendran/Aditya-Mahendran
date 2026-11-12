# Hi, I'm Adi 👋

I like building simple products that sit at the intersection of **AI**, **data**, and **real people’s problems** — especially in climate, education, and emerging markets.

Right now I’m:
- A second-year MBA student at **Kellogg** (Class of 2027), concentrating in Strategy
- Cofounder of **Envira**, an AI-powered ESG questionnaire automation platform
- Fresh off a summer as a **Strategy & Planning MBA Intern at Uber**, working on customer support strategy for Uber Direct
- Previously a PM at the **Kellogg AI Lab** and a Senior Consultant at **West Monroe** (healthcare, tech, and retail)
- Always tinkering with small apps and agents on the side

---

## What I’ve been building

### 🌱 Envira — AI for ESG questionnaires
Cofounded a startup that uses AI to automate the ESG / sustainability questionnaires companies get from customers, investors, and regulators. Along the way we explored pivots in climate tech, including carbon credit verification and sustainability-linked loan compliance.

*Private repo*

---

### 🏁 Race Director — AI race engineer for Northwestern Formula Racing (KAI Hackathon)
Team project from the KAI Hackathon: a workspace where the Northwestern Formula Racing team uploads car telemetry and asks an AI race engineer questions about a run. I owned cross-product demo integration, tying Race Director together with the team’s procurement and pricing tools.

**How it works**
- **Team hub:** a Northwestern-purple car operations hub where you pick a desk (Race Director, Procurement, or Pricing) to open that workspace
- **Telemetry ingestion:** accepts decoded telemetry as long-form CSV/.log, time-based Excel workbooks, and raw `.NFR` logs decoded with a validated team signal definition. It checks headers, timestamp order, duplicates, gaps, and units, and rejects data it can’t decode instead of guessing
- **Prepared engineering review:** opening a run surfaces source-backed findings first: temperatures, current demand and RMS, pack voltage, braking, and RPM
- **Ask the race engineer:** Claude picks from validated, read-only analysis tools while code does the math (signal stats, windowed RMS, threshold excursions). Answers lead with the finding, then the measured evidence, the uncertainty, and the next thing to check
- **Evidence you can inspect:** chart, data, and method views sit beside the conversation, with units, sample windows, source rows, and downloads. Investigations are saved, with step-by-step analysis status that survives reloads
- **Guardrails:** no fabricated runs, curves, or AI answers; no model-generated SQL or code execution; full datasets never go into a prompt; uploads stay private to their owner

**Stack:** TypeScript, React, Express 5, PostgreSQL + Drizzle ORM, Zod, OpenAPI + Orval codegen, pnpm workspaces, Claude · built on Replit

*Private project*

---

### 🔎 KLUE — LLM sales research agent (Kellogg AI Lab)
Product manager on KLUE, an LLM-based agent that researches prospects and accounts so sales teams can show up to conversations prepared.

---

### 🏀 Rebound — basketball training for injured players
A training app built to help basketball players keep getting better while they’re working back from injury:
- Checkbox-based workout tracking
- Five progress meters to track development
- Card-collection game mechanics to keep training fun

*Private repo*

---

### 🤖 Job Tracker Agent
An AI agent that runs my full-time job search out of a Google Sheet:
- Searches LinkedIn and MBA job boards for new roles on a schedule
- De-duplicates postings and scores fit on a 1–10 scale
- Finds a relevant contact per role and drafts a short outreach message
- Built with guardrails: it never sends messages or applications on its own

---

### 🎲 Course Bidding Optimizer
A Monte Carlo simulation and Excel planning workbook built on historical bid data to optimize how I spend points in Kellogg’s course bidding.

---

### 🎧 Spot Sync — Spotify persona app
A small web app that connects to Spotify and builds a “music persona” using:
- Spotify’s Web API (top tracks, audio features, etc.)
- A Supabase backend and edge functions
- A React front end with an animated onboarding flow

🔗 [Live app](https://jam-peek.lovable.app) · [Repo](https://github.com/Aditya-Mahendran/Spot-Sync)

---

### 🥗 Calorie Pal Lite — lightweight food tracker
A simple web app for logging meals and calories without the friction of a heavy tracking app. Built with React, TypeScript, and Supabase.

🔗 [Live app](https://calorie-pal-lite.lovable.app) · [Repo](https://github.com/Aditya-Mahendran/calorie-pal-lite)

---

## What I like working with
- **Languages:** Python, SQL, TypeScript / JavaScript
- **Data / Backend:** Supabase, Postgres, basic ETL, REST APIs
- **Frontend:** React, simple dashboards and tools
- **AI:** LLM agents, prompt and workflow design
- **Other:** Databricks, Airflow, Tableau, Salesforce (FSL), and a lot of client-facing analytics work

## A bit more about me
- I spent four years in tech consulting building data pipelines, analytics, and automation for large clients
- I care a lot about education, social impact, and sustainability — I tutor with Tutoring Chicago and mentor with Genesys Works
- Long term, I want to build (or back) early-stage climate and edtech companies

If you want to chat about AI, climate, or random side projects, feel free to reach out:
- LinkedIn: [aditya-mahendran](https://www.linkedin.com/in/aditya-mahendran/)
- Email: aditya.mahendran2015@gmail.com
