# Supabase Configuration Guide

## Fix Email Redirect URLs

Your Supabase email confirmation links are currently redirecting to `localhost`. Follow these steps to fix it:

### Step 1: Update Site URL in Supabase Dashboard

1. Go to: https://supabase.com/dashboard/project/wuwfqieqbpxesovckyky/auth/url-configuration

2. Set the **Site URL** to your production URL:
   ```
   https://libraryos.live
   ```

3. Add your production URL to **Redirect URLs**:
   ```
   https://libraryos.live/**
   ```

### Step 2: Update Email Templates (Optional)

1. Go to: https://supabase.com/dashboard/project/wuwfqieqbpxesovckyky/auth/templates

2. Customize email templates if needed

### Step 3: Disable Email Confirmation (Alternative)

If you don't need email confirmation for now:

1. Go to: https://supabase.com/dashboard/project/wuwfqieqbpxesovckyky/auth/providers

2. Under **Email** provider settings:
   - Uncheck "Enable email confirmations"

## Current Settings

- **Project Ref**: wuwfqieqbpxesovckyky
- **Production URL**: https://libraryos.live
- **API URL**: https://wuwfqieqbpxesovckyky.supabase.co

## Changes Made

1. ✅ Created `/api/auth/register` route to handle user registration server-side
2. ✅ Auto-confirms email during registration (no confirmation needed)
3. ✅ Uses service role key to bypass RLS restrictions
4. ✅ Automatically signs in user after registration
