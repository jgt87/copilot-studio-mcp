/**
 * Declarative wrappers for the pac commands that have no bespoke tool of
 * their own. Each spec becomes one MCP tool with a typed schema built from
 * `params`, the confirm contract for anything that changes an environment,
 * secret redaction, and the same result shape as the other pac-backed tools.
 *
 * Flags and semantics come from `pac <group> <command> help` on pac 2.11.2.
 * Groups outside Copilot Studio work (canvas, pcf, plugin, pages, code, data,
 * package, admin, ...) stay reachable through `cs_pac`.
 */
import { z } from "zod";

export type ParamType = "string" | "boolean" | "number" | "string[]" | "boolstring";

export interface PacParam {
  /** The pac flag, e.g. `--templateFileName`. */
  flag: string;
  type: ParamType;
  description: string;
  required?: boolean;
  /** Arrays: repeat the flag per value (default) or pass one comma-joined value. */
  join?: "repeat" | "comma";
  /** Masked in logs, dry runs and results. */
  secret?: boolean;
  /** Allowed values for string params. */
  values?: readonly string[];
}

export interface PacCommandSpec {
  tool: string;
  title: string;
  description: string;
  command: readonly string[];
  params: Record<string, PacParam>;
  /** Changes a live environment (needs confirm); a function decides per input. */
  mutating: boolean | ((input: Record<string, unknown>) => boolean);
  timeoutMs?: number;
  /** Appended to every result: verification status or the portal step that remains. */
  note?: string;
}

const ENV: PacParam = { flag: "--environment", type: "string", description: "Environment id or URL; default: the environment of the active pac auth profile" };
const ASYNC: Record<string, PacParam> = {
  async: { flag: "--async", type: "boolean", description: "Run the operation asynchronously" },
  maxAsyncWaitTime: { flag: "--max-async-wait-time", type: "number", description: "Max asynchronous wait time in minutes (default 60)" },
};
const SOLUTION_EXPORT: Record<string, PacParam> = {
  include: { flag: "--include", type: "string", description: "Settings to include in the export (pac solution export --include values)" },
  packageType: { flag: "--packagetype", type: "string", values: ["Unmanaged", "Managed", "Both"], description: "Unmanaged, Managed or Both (default Both)" },
  localize: { flag: "--localize", type: "boolean", description: "Extract string resources into .resx files" },
  map: { flag: "--map", type: "string", description: "Mapping XML file for component folders" },
};

export const PAC_COMMANDS: PacCommandSpec[] = [
  // ---- pac copilot ---------------------------------------------------------
  {
    tool: "cs_extract_agent_template",
    title: "Extract an agent template",
    description: "Write a reusable YAML template from an existing agent (its topics, settings and components), for cs_create_agent_from_template in another environment or solution.",
    command: ["copilot", "extract-template"],
    params: {
      environment: ENV,
      bot: { flag: "--bot", type: "string", required: true, description: "Agent id or schema name" },
      templateFile: { flag: "--templateFileName", type: "string", required: true, description: "Path of the YAML template to write" },
      overwrite: { flag: "--overwrite", type: "boolean", description: "Overwrite the file if it exists" },
      templateName: { flag: "--templateName", type: "string", description: "Template name (default kickStartTemplate)" },
      templateVersion: { flag: "--templateVersion", type: "string", description: "Template version X.Y.Z (default 1.0.0)" },
    },
    mutating: false,
    timeoutMs: 10 * 60_000,
  },
  {
    tool: "cs_create_agent_from_template",
    title: "Create an agent from a template",
    description: "Create a new agent in a solution from a template produced by cs_extract_agent_template.",
    command: ["copilot", "create"],
    params: {
      environment: ENV,
      schemaName: { flag: "--schemaName", type: "string", required: true, description: "Schema (unique) name of the new agent, e.g. contoso_HelpDesk" },
      templateFile: { flag: "--templateFileName", type: "string", required: true, description: "Template YAML from cs_extract_agent_template" },
      displayName: { flag: "--displayName", type: "string", required: true, description: "Display name of the new agent" },
      solution: { flag: "--solution", type: "string", required: true, description: "Unique name of the solution to create the agent in" },
    },
    mutating: true,
    timeoutMs: 15 * 60_000,
    note: "Clone the new agent with cs_clone_agent to get a sync-connected workspace.",
  },
  {
    tool: "cs_extract_translations",
    title: "Extract translation files",
    description: "Export the localisable strings of one or all agents as .resx or .json files, from the environment or from an unpacked solution folder.",
    command: ["copilot", "extract-translation"],
    params: {
      environment: ENV,
      sourceDir: { flag: "--sourcedir", type: "string", description: "Unpacked solution folder to read instead of the environment" },
      bot: { flag: "--bot", type: "string", description: "Agent id or schema name; omit for every agent" },
      outDir: { flag: "--outdir", type: "string", description: "Output directory" },
      format: { flag: "--format", type: "string", values: ["resx", "json"], description: "resx (default) or json" },
      all: { flag: "--all", type: "boolean", description: "Write files for every supported language, not only the primary one" },
      overwrite: { flag: "--overwrite", type: "boolean", description: "Overwrite existing files" },
    },
    mutating: false,
    timeoutMs: 15 * 60_000,
  },
  {
    tool: "cs_merge_translations",
    title: "Merge translation files",
    description: "Import translated .resx or .json files back into one or more agents (environment or unpacked solution folder). whatIf previews the merge without writing.",
    command: ["copilot", "merge-translation"],
    params: {
      environment: ENV,
      sourceDir: { flag: "--sourcedir", type: "string", description: "Unpacked solution folder to update instead of the environment" },
      files: { flag: "--file", type: "string[]", required: true, description: "Translation files; glob patterns allowed" },
      whatIf: { flag: "--whatif", type: "boolean", description: "Report what would change without changing anything" },
      verbose: { flag: "--verbose", type: "boolean", description: "More diagnostic output" },
      solution: { flag: "--solution", type: "string", description: "Solution unique name" },
    },
    mutating: (input) => input.whatIf !== true,
    timeoutMs: 15 * 60_000,
  },
  {
    tool: "cs_quarantine_agent",
    title: "Quarantine or release an agent",
    description: "Put an agent in quarantine (users cannot talk to it) or release it. Admin operation.",
    command: ["copilot", "quarantine"],
    params: {
      environment: ENV,
      botId: { flag: "--bot-id", type: "string", required: true, description: "Agent id (GUID)" },
      quarantine: { flag: "--status", type: "boolstring", description: "true to quarantine (default), false to release" },
    },
    mutating: true,
  },
  // ---- pac solution --------------------------------------------------------
  {
    tool: "cs_init_solution_project",
    title: "Create a solution project",
    description: "Scaffold a Dataverse solution project (.cdsproj) on disk for source-controlled solution development.",
    command: ["solution", "init"],
    params: {
      publisherName: { flag: "--publisher-name", type: "string", required: true, description: "Publisher name" },
      publisherPrefix: { flag: "--publisher-prefix", type: "string", required: true, description: "Publisher customization prefix" },
      outputDirectory: { flag: "--outputDirectory", type: "string", description: "Output directory (default: cwd)" },
    },
    mutating: false,
  },
  {
    tool: "cs_clone_solution",
    title: "Clone a solution into a project",
    description: "Export a solution from the environment and unpack it into a solution project folder (source-control layout). Read-only for the environment.",
    command: ["solution", "clone"],
    params: {
      environment: ENV,
      name: { flag: "--name", type: "string", required: true, description: "Solution unique name" },
      outputDirectory: { flag: "--outputDirectory", type: "string", description: "Output directory" },
      ...SOLUTION_EXPORT,
      ...ASYNC,
    },
    mutating: false,
    timeoutMs: 60 * 60_000,
  },
  {
    tool: "cs_sync_solution",
    title: "Sync a solution project from the environment",
    description: "Re-export the solution and update an existing unpacked solution folder or .cdsproj with the environment's current state. Read-only for the environment.",
    command: ["solution", "sync"],
    params: {
      environment: ENV,
      solutionFolder: { flag: "--solution-folder", type: "string", description: "Unpacked solution folder (Other/Solution.xml root) or .cdsproj folder; default: cwd" },
      ...SOLUTION_EXPORT,
      ...ASYNC,
    },
    mutating: false,
    timeoutMs: 60 * 60_000,
  },
  {
    tool: "cs_check_solution",
    title: "Run Solution Checker",
    description: "Analyse solution zip files with the Power Apps Checker service (Solution Checker or AppSource Certification rule set) and write the results locally. Use as a quality gate before cs_deploy_solution.",
    command: ["solution", "check"],
    params: {
      environment: ENV,
      path: { flag: "--path", type: "string", description: "Solution zip file(s); glob allowed" },
      solutionUrl: { flag: "--solutionUrl", type: "string", description: "SAS URL of a solution zip instead of path" },
      outputDirectory: { flag: "--outputDirectory", type: "string", description: "Where to write the results" },
      geo: { flag: "--geo", type: "string", description: "Checker service geography" },
      ruleSet: { flag: "--ruleSet", type: "string", description: "'Solution Checker' (default), 'AppSource Certification' or a rule set id" },
      ruleLevelOverride: { flag: "--ruleLevelOverride", type: "string", description: "JSON file with rule level overrides" },
      excludedFiles: { flag: "--excludedFiles", type: "string[]", join: "comma", description: "Files to exclude from the analysis" },
      saveResults: { flag: "--saveResults", type: "boolean", description: "Store the results in the environment (Solution Health Hub)" },
      clearCache: { flag: "--clearCache", type: "boolean", description: "Clear the tenant's checker enforcement cache" },
    },
    mutating: (input) => input.saveResults === true || input.clearCache === true,
    timeoutMs: 30 * 60_000,
  },
  {
    tool: "cs_publish_customizations",
    title: "Publish all customizations",
    description: "Publish every unpublished customization in the environment (the 'Publish all customizations' button).",
    command: ["solution", "publish"],
    params: { environment: ENV, ...ASYNC },
    mutating: true,
    timeoutMs: 60 * 60_000,
  },
  {
    tool: "cs_set_solution_version",
    title: "Set the solution version in Solution.xml",
    description: "Update the version in a local unpacked solution's Solution.xml, explicitly or by strategy (gittags, filetracking, solution). Local file change only.",
    command: ["solution", "version"],
    params: {
      solutionPath: { flag: "--solutionPath", type: "string", description: "Unpacked solution folder or Solution.xml" },
      strategy: { flag: "--strategy", type: "string", description: "Version strategy (see pac solution version help)" },
      buildVersion: { flag: "--buildversion", type: "string", description: "Build version" },
      revisionVersion: { flag: "--revisionversion", type: "string", description: "Revision version" },
      filename: { flag: "--filename", type: "string", description: "Tracker CSV for the filetracking strategy" },
    },
    mutating: false,
  },
  {
    tool: "cs_solution_online_version",
    title: "Read or set the online solution version",
    description: "Without solutionVersion: read the version of a solution in the environment. With it: set that version (mutating).",
    command: ["solution", "online-version"],
    params: {
      environment: ENV,
      solutionName: { flag: "--solution-name", type: "string", required: true, description: "Solution unique name" },
      solutionVersion: { flag: "--solution-version", type: "string", description: "New version to set; omit to read" },
    },
    mutating: (input) => typeof input.solutionVersion === "string" && input.solutionVersion.length > 0,
  },
  {
    tool: "cs_upgrade_solution",
    title: "Apply a staged solution upgrade",
    description: "Complete a managed solution upgrade that was imported as a staged upgrade (pac solution import --stage-and-upgrade or the portal's 'Stage for upgrade').",
    command: ["solution", "upgrade"],
    params: { environment: ENV, solutionName: { flag: "--solution-name", type: "string", required: true, description: "Solution unique name" }, ...ASYNC },
    mutating: true,
    timeoutMs: 60 * 60_000,
  },
  {
    tool: "cs_add_solution_component",
    title: "Add a component to a solution",
    description: "Add an existing component (an agent, flow, connection reference, environment variable, table ...) to an unmanaged solution by schema name or id and component type code.",
    command: ["solution", "add-solution-component"],
    params: {
      environment: ENV,
      solutionName: { flag: "--solutionUniqueName", type: "string", required: true, description: "Solution unique name" },
      component: { flag: "--component", type: "string", required: true, description: "Schema name or id of the component" },
      componentType: { flag: "--componentType", type: "string", required: true, description: "Component type code or name (e.g. 29 for a flow / workflow, 10088 for a connection reference, 380 for an environment variable definition)" },
      addRequiredComponents: { flag: "--AddRequiredComponents", type: "boolean", description: "Also add the components it depends on" },
      async: ASYNC.async,
    },
    mutating: true,
  },
  {
    tool: "cs_add_solution_reference",
    title: "Add a project reference to a solution project",
    description: "Reference another project (plug-in, PCF, ...) from a .cdsproj so it is packed into the solution. Run in the solution project folder (cwd). Local file change only.",
    command: ["solution", "add-reference"],
    params: { path: { flag: "--path", type: "string", required: true, description: "Path of the referenced project" } },
    mutating: false,
  },
  {
    tool: "cs_add_solution_license",
    title: "Add license plan files to a solution project",
    description: "Attach license plan definition and mapping CSV files to a solution project (ISV licensing). Run in the solution project folder (cwd). Local file change only.",
    command: ["solution", "add-license"],
    params: {
      planDefinitionFile: { flag: "--planDefinitionFile", type: "string", required: true, description: "CSV: Service ID, Display name, More info URL" },
      planMappingFile: { flag: "--planMappingFile", type: "string", required: true, description: "CSV: Service ID, Component name" },
    },
    mutating: false,
  },
  // ---- pac pipeline --------------------------------------------------------
  {
    tool: "cs_list_pipelines",
    title: "List Power Platform pipelines",
    description: "List the pipelines that can deploy from an environment, or the stages of one pipeline. Read-only.",
    command: ["pipeline", "list"],
    params: { environment: ENV, pipeline: { flag: "--pipeline", type: "string", description: "Pipeline name or id to show its stages" } },
    mutating: false,
  },
  {
    tool: "cs_deploy_pipeline",
    title: "Deploy through a Power Platform pipeline",
    description: "Start a pipeline deployment of a solution to a stage (the alternative to cs_deploy_solution when the tenant uses Power Platform pipelines). stageId comes from cs_list_pipelines.",
    command: ["pipeline", "deploy"],
    params: {
      environment: ENV,
      solutionName: { flag: "--solutionName", type: "string", required: true, description: "Solution unique name" },
      stageId: { flag: "--stageId", type: "string", required: true, description: "Deployment stage id (cs_list_pipelines with pipeline)" },
      currentVersion: { flag: "--currentVersion", type: "string", required: true, description: "Current solution version" },
      newVersion: { flag: "--newVersion", type: "string", required: true, description: "Version to deploy as" },
      wait: { flag: "--wait", type: "boolean", description: "Wait until the deployment finishes" },
    },
    mutating: true,
    timeoutMs: 60 * 60_000,
  },
  // ---- pac connection (service-principal Dataverse connections only) ---------
  {
    tool: "cs_create_connection",
    title: "Create a service-principal Dataverse connection",
    description: "Create a Dataverse connection that authenticates with an app registration (application id + client secret) so flows and tools owned by a pipeline do not depend on a person. This is the only connection kind pac can create; connector connections (SharePoint, Outlook, MCP servers ...) are still authorised in the portal.",
    command: ["connection", "create"],
    params: {
      environment: ENV,
      tenantId: { flag: "--tenant-id", type: "string", required: true, description: "Entra tenant id" },
      name: { flag: "--name", type: "string", required: true, description: "Connection display name" },
      applicationId: { flag: "--application-id", type: "string", required: true, description: "App registration (client) id" },
      clientSecret: { flag: "--client-secret", type: "string", required: true, secret: true, description: "Client secret; prefer a secret from a vault, it is masked in logs" },
    },
    mutating: true,
  },
  {
    tool: "cs_update_connection",
    title: "Update a service-principal Dataverse connection",
    description: "Rotate the app registration or secret behind a service-principal Dataverse connection.",
    command: ["connection", "update"],
    params: {
      environment: ENV,
      tenantId: { flag: "--tenant-id", type: "string", required: true, description: "Entra tenant id" },
      connectionId: { flag: "--connection-id", type: "string", required: true, description: "Connection id (cs_list_connections)" },
      applicationId: { flag: "--application-id", type: "string", required: true, description: "App registration (client) id" },
      clientSecret: { flag: "--client-secret", type: "string", required: true, secret: true, description: "New client secret (masked in logs)" },
    },
    mutating: true,
  },
  {
    tool: "cs_delete_connection",
    title: "Delete a connection",
    description: "Delete a connection by id. Flows and tools bound to it stop working until rebound.",
    command: ["connection", "delete"],
    params: { environment: ENV, connectionId: { flag: "--connection-id", type: "string", required: true, description: "Connection id (cs_list_connections)" } },
    mutating: true,
  },
  // ---- pac auth ------------------------------------------------------------
  {
    tool: "cs_create_auth_profile",
    title: "Create a pac auth profile",
    description: "Create a pac authentication profile without a person at the keyboard: service principal (applicationId + clientSecret + tenant), certificate, managed identity, or GitHub / Azure DevOps federation. For interactive sign-in run 'pac auth create' in a terminal instead: pac opens its own browser and this tool would block until it completes.",
    command: ["auth", "create"],
    params: {
      name: { flag: "--name", type: "string", description: "Profile name (max 30 characters)" },
      environment: { flag: "--environment", type: "string", description: "Default environment for the profile (id, URL, unique or partial name)" },
      applicationId: { flag: "--applicationId", type: "string", description: "App registration (client) id" },
      clientSecret: { flag: "--clientSecret", type: "string", secret: true, description: "Client secret (masked in logs)" },
      tenant: { flag: "--tenant", type: "string", description: "Tenant id (required with applicationId)" },
      certificateDiskPath: { flag: "--certificateDiskPath", type: "string", description: "Certificate file for certificate auth" },
      certificatePassword: { flag: "--certificatePassword", type: "string", secret: true, description: "Certificate password (masked in logs)" },
      username: { flag: "--username", type: "string", description: "User name for username/password auth (not recommended)" },
      password: { flag: "--password", type: "string", secret: true, description: "Password (masked in logs)" },
      cloud: { flag: "--cloud", type: "string", description: "Cloud instance (Public, UsGov, UsGovHigh, UsGovDod, China)" },
      deviceCode: { flag: "--deviceCode", type: "boolean", description: "Use the device-code flow for interactive sign-in (blocks until done)" },
      managedIdentity: { flag: "--managedIdentity", type: "boolean", description: "Use the default Azure identity" },
      githubFederated: { flag: "--githubFederated", type: "boolean", description: "GitHub federated credential (needs tenant and applicationId)" },
      azureDevOpsFederated: { flag: "--azureDevOpsFederated", type: "boolean", description: "Azure DevOps federated credential (needs tenant and applicationId)" },
    },
    mutating: false,
    timeoutMs: 10 * 60_000,
    note: "A service-principal profile needs an application user with a security role in each environment it will touch.",
  },
  {
    tool: "cs_select_auth_profile",
    title: "Select the active pac auth profile",
    description: "Make a pac auth profile the active one, by index (cs_doctor lists them) or name.",
    command: ["auth", "select"],
    params: { index: { flag: "--index", type: "number", description: "Profile index" }, name: { flag: "--name", type: "string", description: "Profile name" } },
    mutating: false,
  },
  {
    tool: "cs_auth_who",
    title: "Show the active pac auth profile",
    description: "Who pac is signed in as, and against which environment.",
    command: ["auth", "who"],
    params: {},
    mutating: false,
  },
  {
    tool: "cs_delete_auth_profile",
    title: "Delete a pac auth profile",
    description: "Remove a pac auth profile by index or name (local credential store only).",
    command: ["auth", "delete"],
    params: { index: { flag: "--index", type: "number", description: "Profile index" }, name: { flag: "--name", type: "string", description: "Profile name" } },
    mutating: false,
  },
  // ---- pac admin: tenant administration -------------------------------------
  // These run as the tenant admin account: pass 'profile', or set CPS_ADMIN_PROFILE.
  {
    tool: "cs_admin_list_environments",
    title: "List environments (admin)",
    description: "Every environment in the tenant with its type, region and state, as the admin centre lists them. Filters by name, type or installed application.",
    command: ["admin", "list"],
    params: {
      environment: { flag: "--environment", type: "string", description: "Only environments whose name or id contains this text" },
      type: { flag: "--type", type: "string", description: "Only environments of this type (Production, Sandbox, Trial, Developer, Teams)" },
      name: { flag: "--name", type: "string", description: "Only environments whose name contains this text" },
      application: { flag: "--application", type: "string", description: "Only environments with this application installed" },
    },
    mutating: false,
  },
  {
    tool: "cs_admin_environment_status",
    title: "Operations in progress",
    description: "Status of the tenant operations that are still running (copies, restores, resets, deletions).",
    command: ["admin", "status"],
    params: {},
    mutating: false,
  },
  {
    tool: "cs_admin_list_tenant_settings",
    title: "Read tenant settings",
    description: "The tenant-wide Power Platform settings (governance, sharing, support, licensing). With settingsFile, pac writes them as JSON to that path; that file is the reference copy to keep in source control.",
    command: ["admin", "list-tenant-settings"],
    params: { settingsFile: { flag: "--settings-file", type: "string", description: "Write the settings to this .json file" } },
    mutating: false,
  },
  {
    tool: "cs_admin_update_tenant_settings",
    title: "Update tenant settings",
    description: "Change tenant-wide settings, either from a settings file or one setting at a time (for example powerPlatform.governance.disableDeveloperEnvironmentCreationByNonAdminUsers). Affects the whole tenant: requires confirm: true.",
    command: ["admin", "update-tenant-settings"],
    params: {
      settingsFile: { flag: "--settings-file", type: "string", description: "A .json file of settings (from cs_admin_list_tenant_settings)" },
      settingName: { flag: "--setting-name", type: "string", description: "Single setting path" },
      settingValue: { flag: "--setting-value", type: "string", description: "Value for that setting" },
    },
    mutating: true,
  },
  {
    tool: "cs_admin_list_dlp_policies",
    title: "List DLP policies",
    description: "Data loss prevention policies in the tenant: the connector groups that decide which connectors an agent or flow may combine.",
    command: ["admin", "dlp-policy", "list"],
    params: {},
    mutating: false,
  },
  {
    tool: "cs_admin_show_dlp_policy",
    title: "Show one DLP policy",
    description: "One data loss prevention policy in full: its connector classification and the environments it applies to.",
    command: ["admin", "dlp-policy", "show"],
    params: { policyName: { flag: "--policy-name", type: "string", required: true, description: "Policy id (GUID); cs_admin_list_dlp_policies shows it" } },
    mutating: false,
  },
  {
    tool: "cs_admin_list_environment_groups",
    title: "List environment groups",
    description: "Environment groups in the tenant (the grouping used for managed-environment rules).",
    command: ["admin", "list-groups"],
    params: {},
    mutating: false,
  },
  {
    tool: "cs_admin_add_environment_to_group",
    title: "Add an environment to a group",
    description: "Put an environment into an environment group, which applies that group's rules to it. Changes tenant configuration: requires confirm: true.",
    command: ["admin", "add-group"],
    params: {
      environmentGroup: { flag: "--environment-group", type: "string", required: true, description: "Environment group name or id" },
      environment: { flag: "--environment", type: "string", description: "Environment id, url, unique or partial name" },
    },
    mutating: true,
  },
  {
    tool: "cs_admin_list_security_roles",
    title: "List security roles",
    description: "Security roles in an environment, optionally including child roles: what cs_admin_assign_user and cs_admin_assign_group can grant.",
    command: ["admin", "list-roles"],
    params: {
      environment: { flag: "--environment", type: "string", description: "Environment id or URL" },
      businessUnit: { flag: "--business-unit", type: "string", description: "Filter by business unit name or id" },
      includeChildRoles: { flag: "--include-child-roles", type: "boolean", description: "Include child roles" },
    },
    mutating: false,
  },
  {
    tool: "cs_admin_list_service_principals",
    title: "List service principals with Dataverse access",
    description: "Entra applications that have an application user in Dataverse: who can act without a person signing in.",
    command: ["admin", "list-service-principal"],
    params: { filter: { flag: "--filter", type: "string", description: "Application name starts-with filter" }, max: { flag: "--max", type: "number", description: "Maximum applications (default 20)" } },
    mutating: false,
  },
  {
    tool: "cs_admin_list_applications",
    title: "List registered Entra applications",
    description: "Entra applications registered with the tenant for Power Platform.",
    command: ["admin", "application", "list"],
    params: {},
    mutating: false,
  },
  {
    tool: "cs_admin_register_application",
    title: "Register an Entra application",
    description: "Register an Entra application with the tenant so it can be used by Power Platform. Changes tenant configuration: requires confirm: true.",
    command: ["admin", "application", "register"],
    params: { applicationId: { flag: "--application-id", type: "string", required: true, description: "Application (client) id" } },
    mutating: true,
  },
  {
    tool: "cs_admin_unregister_application",
    title: "Unregister an Entra application",
    description: "Remove an Entra application's tenant registration. Changes tenant configuration: requires confirm: true.",
    command: ["admin", "application", "unregister"],
    params: { applicationId: { flag: "--application-id", type: "string", required: true, description: "Application (client) id" } },
    mutating: true,
  },
  {
    tool: "cs_admin_list_app_templates",
    title: "List Dynamics 365 app templates",
    description: "The Dynamics 365 application templates that can be installed when creating an environment, per region.",
    command: ["admin", "list-app-templates"],
    params: { region: { flag: "--region", type: "string", description: "Region name (default unitedstates)" } },
    mutating: false,
  },
  {
    tool: "cs_admin_list_backups",
    title: "List environment backups",
    description: "Backups of an environment, with their labels and dates: what cs_admin_restore_environment can restore.",
    command: ["admin", "list-backups"],
    params: { environment: { flag: "--environment", type: "string", description: "Environment id or URL" } },
    mutating: false,
  },
  {
    tool: "cs_admin_backup_environment",
    title: "Back up an environment",
    description: "Take a manual backup of an environment (the platform's own backup, not the file backup cs_backup_tenant writes). Changes a live environment: requires confirm: true.",
    command: ["admin", "backup"],
    params: { environment: { flag: "--environment", type: "string", description: "Environment id or URL" }, label: { flag: "--label", type: "string", required: true, description: "Backup label" } },
    mutating: true,
    timeoutMs: 60 * 60_000,
  },
  {
    tool: "cs_admin_set_backup_retention",
    title: "Set the backup retention period",
    description: "Set how many days backups of an environment are kept (7, 14, 21 or 28). Changes a live environment: requires confirm: true.",
    command: ["admin", "set-backup-retention-period"],
    params: { environment: { flag: "--environment", type: "string", description: "Environment id or URL" }, days: { flag: "--backup-retention-period", type: "number", required: true, description: "7, 14, 21 or 28" }, ...ASYNC },
    mutating: true,
  },
  {
    tool: "cs_admin_restore_environment",
    title: "Restore an environment from a backup",
    description: "Restore a backup into the same or another environment. Overwrites the target's data and customisations: requires confirm: true.",
    command: ["admin", "restore"],
    params: {
      sourceEnvironment: { flag: "--source-env", type: "string", description: "Environment the backup came from" },
      targetEnvironment: { flag: "--target-env", type: "string", description: "Environment to restore into (defaults to the source)" },
      selectedBackup: { flag: "--selected-backup", type: "string", required: true, description: "Backup date as mm/dd/yyyy hh:mm, or 'latest'" },
      name: { flag: "--name", type: "string", description: "Name for the restored environment" },
      skipAuditData: { flag: "--skip-audit-data", type: "boolean", description: "Do not restore audit data" },
      ...ASYNC,
    },
    mutating: true,
    timeoutMs: 4 * 60 * 60_000,
  },
  {
    tool: "cs_admin_copy_environment",
    title: "Copy one environment over another",
    description: "Copy a source environment onto a target environment. Everything in the target is replaced: requires confirm: true.",
    command: ["admin", "copy"],
    params: {
      sourceEnvironment: { flag: "--source-env", type: "string", description: "Environment to copy from" },
      targetEnvironment: { flag: "--target-env", type: "string", description: "Environment to overwrite" },
      name: { flag: "--name", type: "string", description: "Name for the target environment" },
      type: { flag: "--type", type: "string", description: "Copy type (for example MinimalCopy, FullCopy)" },
      skipAuditData: { flag: "--skip-audit-data", type: "boolean", description: "Do not copy audit data" },
      ...ASYNC,
    },
    mutating: true,
    timeoutMs: 4 * 60 * 60_000,
  },
  {
    tool: "cs_admin_create_environment",
    title: "Create an environment",
    description: "Create a Dataverse environment in the tenant. Consumes tenant capacity: requires confirm: true.",
    command: ["admin", "create"],
    params: {
      name: { flag: "--name", type: "string", description: "Environment name" },
      region: { flag: "--region", type: "string", description: "Region (default unitedstates)" },
      type: { flag: "--type", type: "string", required: true, description: "Production, Sandbox, Trial, Developer or Teams" },
      currency: { flag: "--currency", type: "string", description: "Currency (default USD)" },
      language: { flag: "--language", type: "string", description: "Language (default English)" },
      domain: { flag: "--domain", type: "string", description: "Domain part of the environment URL" },
      templates: { flag: "--templates", type: "string[]", join: "comma", description: "Dynamics 365 templates to deploy" },
      securityGroupId: { flag: "--security-group-id", type: "string", description: "Entra security group id (required for a Teams environment)" },
      user: { flag: "--user", type: "string", description: "User to assign to the environment (object id or UPN)" },
      inputFile: { flag: "--input-file", type: "string", description: "JSON file with the arguments" },
      ...ASYNC,
    },
    mutating: true,
    timeoutMs: 2 * 60 * 60_000,
  },
  {
    tool: "cs_admin_delete_environment",
    title: "Delete an environment",
    description: "Delete an environment from the tenant, with everything in it: agents, solutions, flows and data. Irreversible beyond the platform's own backup retention: requires confirm: true.",
    command: ["admin", "delete"],
    params: { environment: { flag: "--environment", type: "string", description: "Environment id or URL" }, ...ASYNC },
    mutating: true,
    timeoutMs: 2 * 60 * 60_000,
  },
  {
    tool: "cs_admin_reset_environment",
    title: "Reset an environment",
    description: "Reset an environment to an empty Dataverse instance. Everything in it is deleted: requires confirm: true.",
    command: ["admin", "reset"],
    params: {
      environment: { flag: "--environment", type: "string", description: "Environment id or URL" },
      name: { flag: "--name", type: "string", description: "New name" },
      currency: { flag: "--currency", type: "string", description: "Currency" },
      language: { flag: "--language", type: "string", description: "Language" },
      domain: { flag: "--domain", type: "string", description: "Domain part of the URL" },
      purpose: { flag: "--purpose", type: "string", description: "Description of the environment's intent" },
      templates: { flag: "--templates", type: "string[]", join: "comma", description: "Dynamics 365 templates" },
      inputFile: { flag: "--input-file", type: "string", description: "JSON file with the arguments" },
      ...ASYNC,
    },
    mutating: true,
    timeoutMs: 2 * 60 * 60_000,
  },
  {
    tool: "cs_admin_set_runtime_state",
    title: "Set environment administration mode",
    description: "Put an environment into administration mode (only admins can use it) or back, and control background operations. Changes a live environment: requires confirm: true.",
    command: ["admin", "set-runtime-state"],
    params: {
      environment: { flag: "--environment", type: "string", required: true, description: "Environment id or URL" },
      runtimeState: { flag: "--runtime-state", type: "string", required: true, description: "AdminMode or Enabled" },
      backgroundOperations: { flag: "--background-operations", type: "string", description: "Background operations state" },
      ...ASYNC,
    },
    mutating: true,
  },
  {
    tool: "cs_admin_set_governance_config",
    title: "Enable or edit managed environments",
    description: "Turn managed environments on ('Standard') or off ('Basic') for an environment and set its governance options: sharing limits, solution checker mode, maker onboarding. Changes tenant governance: requires confirm: true.",
    command: ["admin", "set-governance-config"],
    params: {
      environment: { flag: "--environment", type: "string", required: true, description: "Environment id or URL" },
      protectionLevel: { flag: "--protection-level", type: "string", required: true, values: ["Standard", "Basic"], description: "Standard enables managed environments, Basic disables them" },
      disableGroupSharing: { flag: "--disable-group-sharing", type: "boolean", description: "Disable sharing with groups" },
      limitSharingMode: { flag: "--limit-sharing-mode", type: "string", description: "Sharing limit mode" },
      maxLimitUserSharing: { flag: "--max-limit-user-sharing", type: "number", description: "How many people makers may share canvas apps with" },
      solutionCheckerMode: { flag: "--solution-checker-mode", type: "string", description: "Solution checker validation mode (None, Warn, Block)" },
      checkerRuleOverrides: { flag: "--checker-rule-overrides", type: "string", description: "Solution checker rule overrides" },
      suppressValidationEmails: { flag: "--suppress-validation-emails", type: "boolean", description: "Do not send validation emails" },
      cloudFlowsMode: { flag: "--cloud-flows-mode", type: "string", description: "Sharing limit mode for solution cloud flows" },
      cloudFlowsLimit: { flag: "--cloud-flows-limit", type: "number", description: "How many people makers may share solution cloud flows with" },
      makerOnboardingUrl: { flag: "--maker-onboarding-url", type: "string", description: "Maker onboarding URL" },
      makerOnboardingMarkdown: { flag: "--maker-onboarding-markdown", type: "string", description: "Maker onboarding markdown" },
      excludeAnalysis: { flag: "--exclude-analysis", type: "boolean", description: "Exclude this environment from the weekly usage digest" },
      includeInsights: { flag: "--include-insights", type: "boolean", description: "Show insights on the admin centre home page" },
    },
    mutating: true,
  },
  {
    tool: "cs_admin_assign_user",
    title: "Assign a user to an environment",
    description: "Give a user (or an application user) a security role in an environment. Changes a live environment: requires confirm: true.",
    command: ["admin", "assign-user"],
    params: {
      environment: { flag: "--environment", type: "string", description: "Environment id or URL" },
      user: { flag: "--user", type: "string", required: true, description: "Object id or UPN, or the application id for an application user" },
      role: { flag: "--role", type: "string", required: true, description: "Security role name or id (cs_admin_list_security_roles)" },
      applicationUser: { flag: "--application-user", type: "boolean", description: "The user is an application (service principal)" },
      businessUnit: { flag: "--business-unit", type: "string", description: "Business unit id" },
    },
    mutating: true,
  },
  {
    tool: "cs_admin_assign_group",
    title: "Assign a group to an environment",
    description: "Give an Entra group a security role in an environment through a Dataverse team. Changes a live environment: requires confirm: true.",
    command: ["admin", "assign-group"],
    params: {
      environment: { flag: "--environment", type: "string", description: "Environment id or URL" },
      group: { flag: "--group", type: "string", required: true, description: "Entra group object id" },
      groupName: { flag: "--group-name", type: "string", required: true, description: "Name of the Dataverse team to create" },
      role: { flag: "--role", type: "string", required: true, description: "Security role name or id" },
      teamType: { flag: "--team-type", type: "string", required: true, description: "Team type (Owner, Access, AadSecurityGroup, AadOfficeGroup)" },
      membershipType: { flag: "--membership-type", type: "string", required: true, description: "Membership type (MembersAndGuests, Members, Owners, Guests)" },
      businessUnit: { flag: "--business-unit", type: "string", description: "Business unit id" },
    },
    mutating: true,
  },
  {
    tool: "cs_admin_create_service_principal",
    title: "Create an application user",
    description: "Register an Entra application and give it an application user with a security role in an environment: the headless identity a pipeline signs in as. Changes a live environment: requires confirm: true.",
    command: ["admin", "create-service-principal"],
    params: {
      environment: { flag: "--environment", type: "string", description: "Environment id or URL" },
      name: { flag: "--name", type: "string", description: "Application name to create in Entra" },
      role: { flag: "--role", type: "string", description: "Security role (default System Administrator)" },
    },
    mutating: true,
  },
  {
    tool: "cs_admin_self_elevate",
    title: "Self-elevate to System Administrator",
    description: "Give yourself the System Administrator role in an environment. Needs Global, Power Platform or Dynamics 365 admin. Changes a live environment: requires confirm: true.",
    command: ["admin", "self-elevate"],
    params: { environment: { flag: "--environment", type: "string", description: "Environment id or URL" } },
    mutating: true,
  },
  {
    tool: "cs_admin_query",
    title: "Run a tenant resource query",
    description: "Run a tenant-level resource query (the admin centre's own query language) and optionally write the results to a file as JSON, list or CSV.",
    command: ["admin", "query"],
    params: {
      query: { flag: "--query", type: "string", description: "Resource query JSON as a string" },
      queryFile: { flag: "--query-file", type: "string", description: "File containing the query JSON" },
      outputType: { flag: "--output-type", type: "string", values: ["Json", "List", "Grid"], description: "Json, List or Grid (default Grid)" },
      outputFile: { flag: "--output-file", type: "string", description: "Where to save the results" },
    },
    mutating: false,
  },
  // ---- pac env -------------------------------------------------------------
  {
    tool: "cs_env_list",
    title: "List environments (pac)",
    description: "Environments visible to the active pac auth profile. The pac-based alternative to cs_list_environments, which needs a cs_login.",
    command: ["env", "list"],
    params: { filter: { flag: "--filter", type: "string", description: "Only environments whose name contains this text" } },
    mutating: false,
  },
  {
    tool: "cs_env_who",
    title: "Show environment details (pac)",
    description: "Organisation id, URL, version and the signed-in user for an environment.",
    command: ["env", "who"],
    params: { environment: ENV },
    mutating: false,
  },
  {
    tool: "cs_env_fetch",
    title: "Run a FetchXML query",
    description: "Run a FetchXML query against Dataverse through pac (read-only), e.g. to inspect bot or botcomponent rows without an MSAL sign-in.",
    command: ["env", "fetch"],
    params: {
      environment: ENV,
      xml: { flag: "--xml", type: "string", description: "FetchXML query text" },
      xmlFile: { flag: "--xmlFile", type: "string", description: "File containing the FetchXML query" },
    },
    mutating: false,
  },
  {
    tool: "cs_env_select",
    title: "Select the default environment for the pac profile",
    description: "Set the environment that pac commands use when none is passed (local profile setting).",
    command: ["env", "select"],
    params: { environment: { flag: "--environment", type: "string", required: true, description: "Environment id, URL, unique or partial name" } },
    mutating: false,
  },
];

// ---------------------------------------------------------------------------
// From spec to argv / schema
// ---------------------------------------------------------------------------

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/** pac argv for a tool call; throws on a missing required param or a value outside `values`. */
/** True for the tenant-administration commands, which default to the admin profile. */
export function isAdminCommand(spec: PacCommandSpec): boolean {
  return spec.command[0] === "admin";
}

export function buildPacArgs(spec: PacCommandSpec, input: Record<string, unknown>): string[] {
  const args = [...spec.command];
  for (const [key, p] of Object.entries(spec.params)) {
    const v = input[key];
    if (!present(v)) {
      if (p.required) throw new Error(`${spec.tool}: '${key}' is required (${p.flag})`);
      continue;
    }
    switch (p.type) {
      case "boolean":
        if (v === true) args.push(p.flag);
        break;
      case "boolstring":
        args.push(p.flag, v ? "true" : "false");
        break;
      case "number":
        args.push(p.flag, String(v));
        break;
      case "string[]": {
        const list = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
        if (!list.length) {
          if (p.required) throw new Error(`${spec.tool}: '${key}' needs at least one value`);
          break;
        }
        if (p.join === "comma") args.push(p.flag, list.join(","));
        else for (const x of list) args.push(p.flag, x);
        break;
      }
      default: {
        const s = String(v);
        if (p.values && !p.values.includes(s)) throw new Error(`${spec.tool}: '${key}' must be one of ${p.values.join(", ")}`);
        args.push(p.flag, s);
      }
    }
  }
  return args;
}

/** Values of secret params that were supplied, for masking. */
export function secretValues(spec: PacCommandSpec, input: Record<string, unknown>): string[] {
  return Object.entries(spec.params)
    .filter(([key, p]) => p.secret && present(input[key]))
    .map(([key]) => String(input[key]));
}

export function redactArgs(args: string[], secrets: string[]): string[] {
  return secrets.length ? args.map((a) => (secrets.includes(a) ? "***" : a)) : args;
}

export function isMutating(spec: PacCommandSpec, input: Record<string, unknown>): boolean {
  return typeof spec.mutating === "function" ? spec.mutating(input) : spec.mutating;
}

export function describeSpec(spec: PacCommandSpec): string {
  const confirm = spec.mutating === false ? "" : " Mutates a live environment: requires confirm: true (a dry run otherwise)." + (typeof spec.mutating === "function" ? " Only some inputs mutate; see the parameter descriptions." : "");
  return `${spec.description} Runs 'pac ${spec.command.join(" ")}' with the active pac auth profile.${confirm}`;
}

/** zod shape for the tool input: one field per param, plus cwd, timeoutSeconds and (when relevant) confirm. */
export function zodShapeFor(spec: PacCommandSpec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, p] of Object.entries(spec.params)) {
    let base: z.ZodTypeAny;
    switch (p.type) {
      case "boolean":
      case "boolstring":
        base = z.boolean();
        break;
      case "number":
        base = z.number();
        break;
      case "string[]":
        base = z.array(z.string());
        break;
      default:
        base = p.values ? z.enum(p.values as [string, ...string[]]) : z.string();
    }
    const described = base.describe(p.description + (p.secret ? " (masked in logs and results)" : ""));
    shape[key] = p.required ? described : described.optional();
  }
  shape.profile = z.string().optional().describe("pac auth profile to run as: the admin account for tenant commands. Defaults to CPS_ADMIN_PROFILE for admin commands and CPS_PAC_PROFILE otherwise, then the active profile. cs_doctor lists the profiles.");
  shape.cwd = z.string().optional().describe("Working directory for pac (for project commands: the solution project folder)");
  shape.timeoutSeconds = z.number().optional().describe(`Default ${Math.round((spec.timeoutMs ?? 600_000) / 1000)}`);
  if (spec.mutating !== false) shape.confirm = z.boolean().optional().describe("Required to actually perform a change in a live environment. Without it the tool returns a dry run.");
  return shape;
}
