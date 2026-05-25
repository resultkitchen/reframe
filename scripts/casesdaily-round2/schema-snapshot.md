# public schema snapshot — captured 2026-05-20 from information_schema.columns

Tables referenced by the casesdaily admin + media-buyer dashboards. Use these column names verbatim. Anything not listed here either does not exist or lives in a different schema.

## ghl_leads (4027 rows)
id text NOT NULL, contact_id text, name text, first_name text, last_name text, email text, phone text, source text, pipeline_id text, pipeline_stage_id text, status text, monetary_value numeric, tags ARRAY, contact_data jsonb, raw_data jsonb, ghl_created_at timestamptz, ghl_updated_at timestamptz, synced_at timestamptz, created_at timestamptz, updated_at timestamptz, attorney_account_id uuid, casesdaily_lead_id uuid

## ghl_lead_overrides
lead_id text NOT NULL, mb_status text, mb_status_source text, mb_status_at timestamptz, client_billed text, client_billed_source text, client_billed_at timestamptz, assigned_client text, buyer_override text, buyer_override_source text, lead_notes text, mb_notes text, bill_notes text, cost_override numeric, revenue_override numeric, meta_excluded boolean, created_at timestamptz, updated_at timestamptz, case_quality text, case_quality_source text, case_quality_at timestamptz, legit_info text, real_contact text

## ghl_orders
id text NOT NULL, client text NOT NULL, ordered integer NOT NULL, filled integer NOT NULL, price_per_lead numeric NOT NULL, total_value numeric NOT NULL, payment_received numeric NOT NULL, payment_type text, status text, date_opened text, date_filled text, notes text, created_at timestamptz, updated_at timestamptz, lead_order_id uuid

## ghl_buyers (use this for buyer matching in MV/enrichment, NOT media_buyers)
id uuid NOT NULL, name text NOT NULL, tags ARRAY NOT NULL, cost_per_lead numeric NOT NULL, status text NOT NULL, notes text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, railway_id text, media_buyer_id uuid

## ghl_agents
id text NOT NULL, name text NOT NULL, tags ARRAY, status text, notes text, created_at timestamptz, updated_at timestamptz

## casesdaily_leads (the funnel-side lead table)
id uuid NOT NULL, attorney_account_id uuid, session_id text, first_name text, last_name text, email text, phone text, case_description text, accident_date text, injuries text, qualification_answers jsonb, ai_conversation jsonb, ai_score integer, is_qualified boolean, disqualified_reason text, status text, source text, utm_source text, utm_medium text, utm_campaign text, ip_address text, user_agent text, created_at timestamptz, updated_at timestamptz, completed_at timestamptz, webhook_sent_at timestamptz, tcpa_consent boolean, lead_order_id uuid, media_buyer_id uuid, utm_content text, utm_term text, mb_campaign_id text, mb_creative_id text, landing_page_domain text, funnel_drop_off_step text, media_buyer_note text, tcpa_consent_url text, is_overflow boolean, ab_test_id uuid, ab_test_variant_id uuid, lead_outcome text, lead_outcome_at timestamptz, lead_outcome_notes text, state text, referrer_url text, landing_page_url text, lead_quality text, funnel_variant text, funnel_step_data jsonb, gclid text, fbclid text, current_step integer, webhook_sent boolean, consent_given boolean, ghl_lead_id text, ghl_stage text, ghl_pipeline text, language text, click_id text, postback_sent boolean, postback_sent_at timestamptz, postback_response text, ad_content jsonb

## casesdaily_domains
id uuid NOT NULL, domain text NOT NULL, subdomain text, root_domain text, attorney_account_id uuid, landing_page_config jsonb, is_active boolean, is_verified boolean, ssl_status text, dns_configured boolean, created_at timestamptz, verified_at timestamptz, notes text

## attorney_accounts
id uuid NOT NULL, firm_name text NOT NULL, contact_name text NOT NULL, email text NOT NULL, phone text NOT NULL, primary_state text NOT NULL, landing_page_config jsonb, lead_filters jsonb, status text, appointment_booked boolean, appointment_date timestamptz, ghl_contact_id text, created_at timestamptz, updated_at timestamptz, activated_at timestamptz, lead_criteria jsonb, notes_for_team text, is_approved boolean, approved_at timestamptz, approved_by uuid, slug text, webhook_url text, accepted_languages ARRAY, notes_webhook_url text, direct_ghl_notes_enabled boolean NOT NULL, notes_webhook_secret text

## media_buyers (the onboarding/profile table for media buyer USERS — do NOT confuse with ghl_buyers)
id uuid NOT NULL, user_id uuid NOT NULL, company_name text, specializations ARRAY, max_active_orders integer, notification_preferences jsonb, total_orders_completed integer, total_leads_generated integer, average_cost_per_lead numeric, is_active boolean, created_at timestamptz, updated_at timestamptz, payment_info jsonb, onboarding_completed boolean, tax_info_acknowledged boolean, terms_accepted_at timestamptz, invite_token text, invite_sent_at timestamptz, invite_accepted_at timestamptz, slug text, webhook_url text, tracking_head_code text, tracking_body_code text, ai_api_url text, funnel_config jsonb, default_attorney_account_id uuid, ghl_tags ARRAY, ghl_cost_per_lead numeric, postback_config jsonb

## lead_orders (the attorney-facing fulfillment table — NOT ghl_orders)
id uuid NOT NULL, order_number text NOT NULL, attorney_account_id uuid, media_buyer_id uuid, assigned_by uuid, assigned_at timestamptz, status text NOT NULL, budget_total numeric NOT NULL, budget_daily_cap numeric, budget_spent numeric, price_per_lead numeric, lead_goal integer, attorney_rate numeric, media_buyer_rate numeric, is_reseller boolean, reseller_rate numeric, accounting_status text, start_date date, end_date date, targeting_config jsonb, lead_filters jsonb, landing_page_config jsonb, attorney_notes text, admin_notes text, media_buyer_notes text, created_at timestamptz, updated_at timestamptz, approved_at timestamptz, approved_by uuid, parent_order_id uuid, webhook_url text, webhook_disable_global boolean, payment_received numeric, payment_type text, accepted_languages ARRAY, free_leads integer NOT NULL

## funnel_events (33k+ rows — analytics events per session)
id uuid NOT NULL, session_id text NOT NULL, attorney_account_id uuid, media_buyer_id uuid, lead_order_id uuid, lead_id uuid, event_type text NOT NULL, event_data jsonb, form_field text, field_value_length integer, time_on_field_ms integer, landing_page_domain text, landing_page_path text, utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text, mb_campaign_id text, mb_creative_id text, referrer text, ip_address text, user_agent text, device_type text, browser text, os text, country text, region text, city text, created_at timestamptz, ab_test_id uuid, ab_test_variant_id uuid, funnel_key text, buyer_slug text, question_id text, step_position integer

## funnel_leads (legacy funnel leads — newer leads land in casesdaily_leads)
id uuid NOT NULL, funnel_variant text NOT NULL, ... (see casesdaily_leads for the active table)

## ab_tests / ab_test_variants
ab_tests: id uuid, lead_order_id uuid, name text, status text, traffic_split integer, ...
ab_test_variants: id uuid, ab_test_id uuid, name text, is_control boolean, question_order jsonb, created_at timestamptz

## VIEWS

### enriched_leads_v (camelCase wrapper over enriched_leads_mv — refreshes every 5 min via pg_cron)
Columns match the EnrichedGHLLead TS interface: id, "contactId", "firstName", "lastName", name, phone, email, "whatHappened", "agentNotes", pipeline, "pipelineId", stage, "stageId", status, "ghlStatus", tags, "mediaBuyer", "buyerId", agent, "agentId", "isSpanish", "isInternal", "isReferral", "mbStatus", "clientBilled", "caseQuality", "mbReviewed", "billReviewed", responded, contacted, cost, revenue, profit, source, "sourceLabel", "utmSource", "utmCampaign", "utmContent", fbclid, "isFacebook", "monetaryValue", "createdAt", ghl_created_at, date, "assignedClient", "attorneyAccountId", "casesdailyLeadId", "legitInfo", "realContact", "mbNotes", "billNotes", "leadNotes", "metaExcluded", "isDuplicate", "duplicateOf", "orderTag", "customFields", "_buyerSource", "_mbSource", "_billSource", "_caseQualitySource", "_costSource", "_revSource"

## Important pairings
- buyer matching: query `ghl_buyers` (has name, tags, cost_per_lead, status='active')
- media buyer USER (for who owns leads): query `media_buyers` via media_buyer_id FK
- legacy/admin orders: `ghl_orders`; newer attorney-facing: `lead_orders`
- analytics events: `funnel_events` (use `funnel_key`, `buyer_slug` for per-template + per-buyer rollups)
- attorney URL slug: `attorney_accounts.slug`
- internal-domain audit: `casesdaily_domains.domain` where `is_active=true`
