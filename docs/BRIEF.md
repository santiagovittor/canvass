Brief — Outreach queue is broken

Symptoms I can see:
- Ran the Prepare a batch function in automation and it is stuck since 20 minutes ago. Investigate
- Most of the emails were flagged as 'bad_email' and i am not sure why, because i investigated and they are present in their websites, like for example (not exhaustive, but just for you to check):
-- Estudio Jurídico Garrafa - Estofan - Koulinka & Santiago: email_invalid:jcgarrafa@bariloche.com.ar
-- LIFT Asset Management, S.L.: email_invalid:info@lift-am.com
- That Estudio Juridico Garrafa had many emails apart from that one, we should try to decide if it is a good aproach to send to more than one email if available, because sometimes we might be missing some leads emails because we are sending to the wrong onw
- We need to make sure we dont have a blacklist because it is weird that im not getting ANY response at all. This is key
- I created another email of myself: santiagovittordev@gmail.com . We should try to wire that in into our app so some emails are sent from svittordev and some from santiagovittordev. That way we should be able to send more emails per day and avoid blacklists
- Gemini seems to be getting this timeouts or errors and I want to know if it is me or if it is the service they provide and everyone experiences it
- Each time you add a function that takes some space i lose the chance of scrolling down to see what is in the buttom. now it is again broken and cant scroll to see all the leads scraped in explorer for example 

What I want:
- To solve the uncertainty when i run a batch. A 15 leads batch should take around 10 to 15 minutes TOPS or at the very least it should take aproximately the same every time and finish it, never end up in a weird stale state. Now we are stuck in that loop of works fine once, then fails silently, then works. This needs to be like a factory, trigger start pum pum email pum pum email and needs to work consistently so i can send around 100 emails per day with the 2 emails confidently and dont have backlog leads who are potential clients.
- Solve the bad_email current issue that is costing us time and resources
- Decide if it is a good idea to add more than 1 email per lead if available 
- Wire my second email so ask me what you need for that
- Decide if Gemini is reliable for this task or if we can use other cheap model for the generation (probably free ollama cloud models that can do this task or opencode go models or specially the NVIDIA NIM API available models, like DeepSeek-V4-Flash / DeepSeek V4 Pro or Kimi (K2.5 / K2.6) or Nemotron-3-Ultra-550b but feel free to investigate for my particular use case bonuspoints if it is free)


What I do NOT want:
- Quality regressions hidden.
- Lazy behaviour.



