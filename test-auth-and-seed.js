import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

// Read .env file
const envText = fs.readFileSync('.env', 'utf-8');
const env = {};
envText.split('\n').forEach(line => {
  const parts = line.split('=');
  if (parts.length >= 2) {
    const key = parts[0].trim();
    const value = parts.slice(1).join('=').trim();
    env[key] = value;
  }
});

const supabaseUrl = env['VITE_SUPABASE_URL'];
const supabaseAnonKey = env['VITE_SUPABASE_ANON_KEY'];

console.log('Supabase URL:', supabaseUrl);
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function runSeed() {
  const email = 'admin.tracker@gmail.com';
  const password = 'password123';

  console.log(`\n1. Authenticating user: ${email}...`);
  let sessionUser = null;

  // Try to sign in first to avoid email rate limits if user already exists
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (!signInError) {
    console.log('Sign in successful!');
    sessionUser = signInData.user;
  } else {
    console.log('Sign in failed or user does not exist, attempting sign up...', signInError.message);
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: 'System Admin'
        }
      }
    });

    if (signUpError) {
      console.error('Sign up failed:', signUpError.message, signUpError);
      return;
    } else {
      sessionUser = signUpData.user;
      console.log('Sign up successful! Please check your Supabase Auth dashboard to confirm/verify the email if required.');
    }
  }

  if (!sessionUser) {
    console.error('Could not obtain session user.');
    return;
  }

  const userId = sessionUser.id;
  console.log('Authenticated User ID:', userId);

  // Let's verify the profile
  console.log('\n2. Verifying user profile...');
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (profileErr) {
    console.error('Profile fetch failed:', profileErr.message);
    return;
  }

  console.log('Current Profile:', profile);
  if (profile.role !== 'admin' || !profile.is_active) {
    console.log('Profile is not an active admin. Attempting to update to active admin...');
    // Since we are the client, normally RLS restricts updating our own role.
    // But since this might be the very first user, let's see. The trigger handle_new_user
    // should have set role = 'admin' and is_active = true.
  }

  // 3. Check categories
  console.log('\n3. Checking categories...');
  const { data: categories, error: categoriesErr } = await supabase
    .from('categories')
    .select('*');
  
  if (categoriesErr) {
    console.error('Failed to select categories:', categoriesErr.message);
    return;
  }
  console.log(`Found ${categories.length} categories.`);

  if (categories.length === 0) {
    console.log('No categories found. Seeding default categories...');
    const defaultCategories = [
      { name: 'Travel', color: '#3b82f6', description: 'Flights, trains, intercity travel' },
      { name: 'Transportation', color: '#06b6d4', description: 'Local transit, taxis, rentals, fuel' },
      { name: 'Accommodation', color: '#8b5cf6', description: 'Hotels, lodging, short-term rentals' },
      { name: 'Photographer Pay', color: '#ec4899', description: 'Fees paid to photographers/talent' },
      { name: 'Equipment Rental', color: '#f59e0b', description: 'Cameras, lighting, AV, props' },
      { name: 'Catering', color: '#10b981', description: 'Food and drink during shoots/events' },
      { name: 'Software', color: '#a855f7', description: 'Subscriptions and licenses' },
      { name: 'Marketing', color: '#ef4444', description: 'Ads, paid promotion' },
      { name: 'Misc', color: '#64748b', description: 'Everything else' }
    ];
    const { error: catSeedErr } = await supabase.from('categories').insert(defaultCategories);
    if (catSeedErr) {
      console.error('Error seeding categories:', catSeedErr.message);
    } else {
      console.log('Categories seeded successfully!');
    }
  }

  // Refetch categories to get their IDs
  const { data: dbCategories } = await supabase.from('categories').select('*');

  // 4. Seed Years
  console.log('\n4. Checking years...');
  const { data: years, error: yearsErr } = await supabase.from('years').select('*');
  if (yearsErr) {
    console.error('Failed to query years:', yearsErr.message);
    return;
  }
  console.log(`Found ${years.length} years.`);

  if (years.length === 0) {
    console.log('Seeding years 2024 and 2025...');
    const { error: yearInsertErr } = await supabase.from('years').insert([
      { year_value: 2024, label: '2024', created_by: userId },
      { year_value: 2025, label: '2025', created_by: userId }
    ]);
    if (yearInsertErr) {
      console.error('Error inserting years:', yearInsertErr.message);
      return;
    }
  }

  const { data: dbYears } = await supabase.from('years').select('*');
  const yearMap = {};
  dbYears.forEach(y => {
    yearMap[y.year_value] = y.id;
  });

  // 5. Seed Projects
  console.log('\n5. Checking projects...');
  const { data: projects, error: projectsErr } = await supabase.from('projects').select('*');
  if (projectsErr) {
    console.error('Failed to query projects:', projectsErr.message);
    return;
  }
  console.log(`Found ${projects.length} projects.`);

  if (projects.length === 0) {
    console.log('Seeding projects...');
    const { error: projInsertErr } = await supabase.from('projects').insert([
      {
        year_id: yearMap[2024],
        name: 'Acme Brand Refresh',
        description: 'Photography & creative for Acme rebrand',
        client: 'Acme Co',
        location: 'Berlin',
        status: 'completed',
        start_date: '2024-03-01',
        end_date: '2024-04-30',
        created_by: userId
      },
      {
        year_id: yearMap[2024],
        name: 'Q4 Product Launch',
        description: 'Hero shots and launch event coverage',
        client: 'Globex',
        location: 'New York',
        status: 'completed',
        start_date: '2024-10-01',
        end_date: '2024-12-15',
        created_by: userId
      },
      {
        year_id: yearMap[2025],
        name: 'Spring Campaign',
        description: 'Outdoor lifestyle shoots',
        client: 'Initech',
        location: 'Lisbon',
        status: 'active',
        start_date: '2025-03-15',
        end_date: null,
        created_by: userId
      },
      {
        year_id: yearMap[2025],
        name: 'Trade Show – Photo Wall',
        description: 'Booth photo wall & headshots',
        client: 'Soylent Corp',
        location: 'San Francisco',
        status: 'active',
        start_date: '2025-05-01',
        end_date: '2025-05-07',
        created_by: userId
      },
      {
        year_id: yearMap[2025],
        name: 'Internal Brand Library',
        description: 'Library refresh, multi-location',
        client: null,
        location: null,
        status: 'planning',
        start_date: '2025-06-01',
        end_date: null,
        created_by: userId
      }
    ]);

    if (projInsertErr) {
      console.error('Error seeding projects:', projInsertErr.message);
      return;
    }
  }

  const { data: dbProjects } = await supabase.from('projects').select('*');

  // 6. Seed Expenses (Demo Data)
  console.log('\n6. Checking expenses...');
  const { data: expenses, error: expensesErr } = await supabase.from('expenses').select('*');
  if (expensesErr) {
    console.error('Failed to query expenses:', expensesErr.message);
    return;
  }
  console.log(`Found ${expenses.length} expenses.`);

  if (expenses.length === 0) {
    console.log('Seeding realistic expenses...');
    const expenseDescriptions = [
      'Flight to venue',
      'Hotel night',
      'Photographer fee - day rate',
      'Camera rental',
      'Catering for crew',
      'Software subscription',
      'Local taxi',
      'Misc supplies'
    ];

    const generatedExpenses = [];

    // Loop through each project and generate ~8 expenses per project
    dbProjects.forEach(proj => {
      for (let i = 1; i <= 8; i++) {
        const category = dbCategories[Math.floor(Math.random() * dbCategories.length)];
        const baseDesc = expenseDescriptions[Math.floor(Math.random() * expenseDescriptions.length)];
        const desc = `${baseDesc} #${i}`;
        const amount = parseFloat((Math.random() * 800 + 50).toFixed(2));
        
        // Random date within the last 365 days
        const daysAgo = Math.floor(Math.random() * 365);
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        const expenseDate = date.toISOString().split('T')[0];

        generatedExpenses.push({
          project_id: proj.id,
          category_id: category.id,
          description: desc,
          amount: amount,
          currency: 'USD',
          expense_date: expenseDate,
          location: proj.location || 'HQ',
          created_by: userId
        });
      }
    });

    console.log(`Inserting ${generatedExpenses.length} generated expenses...`);
    const { error: expInsertErr } = await supabase.from('expenses').insert(generatedExpenses);
    if (expInsertErr) {
      console.error('Error seeding expenses:', expInsertErr.message);
    } else {
      console.log('Expenses seeded successfully!');
    }
  }

  console.log('\n--- Seeding Process Finished ---');
  console.log('Credentials for logging in:');
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}`);
}

runSeed();
