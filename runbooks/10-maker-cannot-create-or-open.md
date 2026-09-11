# 10 A maker cannot create or open an agent

"I do not see the environment", "Create is greyed out", "you do not have permission", "Copilot
Studio says there is no environment". This one is entirely on the admin side: the environment
is not ready or not visible to them, they lack a role in it, or a tenant-level switch is off.
None of it is fixed in the agent.

## Prompt

```
<preamble from README.md>

Run runbooks/10-maker-cannot-create-or-open.md for maker <upn> in environment
"<environment>". The maker reports: "<symptom, quoted>". Check the environment's type, state
and readiness, the maker's roles there, and the tenant settings that gate Copilot Studio, and
propose the role assignment as a dry run.
```

## What you need

- The admin profile (`profile=admin` on every call here). No workspace, no `cs_login`.

## Steps

### 1. The environment (no writes)

```
cs_admin_list_environments profile=admin name="<environment>"
cs_admin_environment_status profile=admin
```

Record type, state, region, and whether an operation (create, copy, reset, restore) is in
progress.

- IF the environment does not appear -> it does not exist, or it lives in another tenant
  (a guest maker). Ask which URL they use.
- IF state is not Ready, or an operation is running -> wait; nothing else helps.
- IF the environment has no Dataverse -> Copilot Studio needs one; the environment must be
  recreated or upgraded with a database (admin centre).
- IF the environment has a security group -> only members see it in the environment picker.
  Membership is in Entra; the group is shown in the admin centre's environment details.

### 2. Roles (no writes)

```
cs_admin_list_security_roles environment=<environment id> profile=admin
```

The maker needs, in **this** environment: **Environment Maker** to create agents (System
Customizer also works and is broader), plus whatever Copilot Studio author role your tenant
uses for existing agents. Roles are per environment; a role in their own developer environment
means nothing here.

- IF the maker was never added to the environment -> they cannot hold a role there yet;
  provisioning happens on first access or when a role is assigned.

### 3. Tenant-level gates (no writes)

```
cs_admin_list_tenant_settings profile=admin
cs_admin_list_environment_groups profile=admin
```

Look for the Copilot Studio entries in the tenant settings (trials, who may author, sharing)
and, if the environment is in a group, the group's rules (managed environments can restrict
who creates agents and what they may use). Record the ones that are off or restrictive.

- IF a tenant setting disables Copilot Studio authoring for non-admins ->
  `cs_admin_update_tenant_settings` changes it (dry run, then `confirm`), knowing it affects
  every maker in the company. Say so before asking.

### 4. Licence (portal)

A maker without a Copilot Studio licence (or an expired trial) gets the "you do not have
access" family of messages regardless of roles. The Microsoft 365 admin centre > Users >
Licenses is the place; the server does not read licences.

### 5. The fix (changes the environment: dry run, then confirm)

```
cs_admin_assign_user environment=<environment id> user=<upn> role="Environment Maker" profile=admin
cs_admin_assign_user environment=<environment id> user=<upn> role="Environment Maker" profile=admin confirm=true
```

One user, one role per call. For a team, `cs_admin_assign_users` takes a CSV under one
approval and shows every pair first; for a group,
`cs_admin_assign_group` binds an Entra group to the role once and new joiners inherit it -
Microsoft's recommendation, and the one that does not need you next time.

### 6. Record

Environment id, state, security group, the maker's roles before and after, the tenant
settings checked, and the licence status the maker or the M365 admin centre reported.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| environment missing from the picker | security group on the environment; wrong tenant | step 1 | group membership; correct URL |
| environment there, Create disabled | no Environment Maker role | step 2 | step 5 |
| "no Dataverse" / cannot open Copilot Studio here | environment without a database | step 1 | add Dataverse (admin centre) |
| everything set, still refused | licence; tenant setting; managed-environment rule | steps 3-4 | licence; setting (dry run, confirm); group rule |
| can open others' agents but not create | maker role missing, viewer role present | step 2 | step 5 |
| works today, refused tomorrow | environment operation in progress; trial ended | step 1; step 4 | wait; licence |

## Fix note

To the maker: what was granted (role, environment), what they still need (licence, a group),
and the URL of the environment. To yourself: prefer the group binding so the next request is
a group membership change, not a role assignment.

## Verify

The maker creates a scaffold agent; `cs_list_agents environmentId=<environment id> via=pac`
shows it. Delete the scaffold afterwards if it was only a test (`cs_delete_agent`, dry run then
confirm - irreversible).

## Known gaps

- Licences are not readable from here.
- The exact tenant-setting names for Copilot Studio change; the output is the authority, this
  runbook says what to look for.
- `cs_admin_environment_status` reports operations tenant-wide; match the environment by id.
