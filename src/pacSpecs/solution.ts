/**
 * Solution projects, Solution Checker, versioning and upgrades.
 *
 * One entry per command; the flags come from `pac solution <command> help` on pac 2.11.2.
 */
import { ASYNC, ENV, SOLUTION_EXPORT, type PacCommandSpec } from "../pacParams.js";

export const SPECS: PacCommandSpec[] = [
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
  }
];
