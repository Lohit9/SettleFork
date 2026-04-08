# Settle Authentication System

Production-grade authentication system using Supabase Auth with Next.js App Router.

## Features

- ✅ Email + Password authentication
- ✅ Email verification (required)
- ✅ Password reset flow
- ✅ Secure session management with SSR
- ✅ Row Level Security (RLS) on profiles
- ✅ Protected routes with middleware
- ✅ Server-side authentication checks
- ✅ Secure cookie-based sessions

## Environment Variables

Create a `.env.local` file in the root directory:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Supabase Setup

### 1. Create the Profiles Table

Run the migration in your Supabase SQL editor:

```sql
-- See supabase/migrations/001_create_profiles.sql
```

Or execute the SQL directly in the Supabase dashboard:
- Go to SQL Editor
- Paste the contents of `supabase/migrations/001_create_profiles.sql`
- Run the migration

### 2. Configure Auth Settings

In your Supabase Dashboard → Authentication → URL Configuration:

**Site URL:**
- Local: `http://localhost:3000`
- Production: `https://www.usesettle.ai`

**Redirect URLs:**
Add these redirect URLs:
- `http://localhost:3000/api/auth/callback`
- `https://www.usesettle.ai/api/auth/callback`
- `http://localhost:3000/reset-password`
- `https://www.usesettle.ai/reset-password`
- `http://localhost:3000/verify-email`
- `https://www.usesettle.ai/verify-email`

### 3. Enable Email Verification

In Supabase Dashboard → Authentication → Settings:
- Enable "Enable email confirmations"
- Configure email templates as needed

### 4. Configure Password Reset

- Ensure "Enable email confirmations" is enabled
- Password reset emails will be sent automatically

## Routes

### Public Routes
- `/login` - Sign in page
- `/signup` - Sign up page
- `/forgot-password` - Request password reset
- `/reset-password` - Reset password (requires valid token)
- `/verify-email` - Email verification status
- `/api/auth/callback` - OAuth/email callback handler

### Protected Routes
- `/app/*` - All app routes require authentication
- `/app/profile` - User profile page

## Security Features

1. **Server-Side Session Management**
   - Uses `@supabase/ssr` for secure cookie handling
   - Sessions stored in HTTP-only cookies
   - Automatic token refresh

2. **Route Protection**
   - Middleware checks authentication on all `/app/*` routes
   - Server Components verify user on each request
   - Client-side guards as backup

3. **Error Handling**
   - Generic error messages to prevent account enumeration
   - No revealing of whether emails exist
   - Safe error boundaries

4. **Row Level Security**
   - Users can only access their own profile
   - Policies enforced at database level
   - No service role keys in client code

5. **Input Validation**
   - Client-side validation
   - Server-side validation via Supabase
   - Password strength requirements

## Database Schema

### Profiles Table

```sql
profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  full_name TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
```

**RLS Policies:**
- Users can SELECT their own profile
- Users can UPDATE their own profile
- Users can INSERT their own profile (via trigger)

## Testing

### 1. Sign Up
1. Navigate to `/signup`
2. Fill in the form
3. Check email for verification link
4. Click verification link
5. Should redirect to `/verify-email?verified=true`

### 2. Sign In
1. Navigate to `/login`
2. Enter credentials
3. Should redirect to `/app/projects`

### 3. Password Reset
1. Navigate to `/forgot-password`
2. Enter email
3. Check email for reset link
4. Click link → redirects to `/reset-password`
5. Enter new password
6. Should redirect to `/app/projects`

### 4. Profile Access
1. Navigate to `/app/profile`
2. Should see user information
3. Can sign out

### 5. Route Protection
1. While logged out, try accessing `/app/projects`
2. Should redirect to `/login`
3. After login, should redirect back to `/app/projects`

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```

## Production Deployment

1. Set environment variables in your hosting platform (Vercel, etc.)
2. Update Supabase redirect URLs to include production domain
3. Ensure email templates are configured
4. Test all auth flows in production

## Troubleshooting

### "Invalid login credentials" even with correct password
- Check if email is verified
- Verify Supabase Auth settings
- Check browser console for errors

### Redirect loops
- Verify middleware configuration
- Check Supabase redirect URLs
- Ensure cookies are being set properly

### Profile not created on signup
- Verify trigger is created: `on_auth_user_created`
- Check Supabase logs for errors
- Ensure RLS policies allow INSERT

### Email not sending
- Check Supabase email settings
- Verify SMTP configuration
- Check spam folder
- Review Supabase logs

## Architecture

```
lib/
  supabase/
    client.ts      # Browser client (uses @supabase/ssr)
    server.ts      # Server client (uses @supabase/ssr)
  actions/
    auth.ts        # Server actions (signOut, etc.)

middleware.ts      # Route protection & session refresh

app/
  login/           # Sign in page
  signup/          # Sign up page
  forgot-password/ # Password reset request
  reset-password/  # Password reset form
  verify-email/    # Email verification status
  api/
    auth/
      callback/    # OAuth/email callback handler
  app/
    profile/       # Protected profile page
```

## Best Practices

1. **Never expose service role keys** - Only use anon key in client
2. **Always verify auth server-side** - Don't trust client-side checks alone
3. **Use RLS policies** - Enforce security at database level
4. **Handle errors gracefully** - Don't reveal sensitive information
5. **Keep sessions secure** - Use HTTP-only cookies, secure flags in production
6. **Validate inputs** - Both client and server side
7. **Rate limit auth endpoints** - Consider adding rate limiting middleware
