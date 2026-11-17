<?php
/* Copyright (C) 2026 LH Wong
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * \file    admin/setup.php
 * \ingroup dolibarrmcpserver
 * \brief   Setup page: checks and installation instructions for the MCP server
 */

$res = 0;
if (!$res && file_exists("../../main.inc.php")) {
	$res = @include "../../main.inc.php";
}
if (!$res && file_exists("../../../main.inc.php")) {
	$res = @include "../../../main.inc.php";
}
if (!$res && file_exists("../../../../main.inc.php")) {
	$res = @include "../../../../main.inc.php";
}
if (!$res) {
	die("Include of main fails");
}

require_once DOL_DOCUMENT_ROOT.'/core/lib/admin.lib.php';

$langs->loadLangs(array("admin", "dolibarrmcpserver@dolibarrmcpserver"));

if (!$user->admin) {
	accessforbidden();
}

$serverdir = dirname(__DIR__).'/mcp-server';
$dolibarrurl = preg_replace('/\/$/', '', DOL_MAIN_URL_ROOT);
$apienabled = isModEnabled('api');
$serverpresent = is_file($serverdir.'/dist/index.js');
$haskey = !empty($user->api_key);
$docurl = 'https://github.com/frankiewonghk/dolibarr-mcp-server';

/**
 * Print a yes/no badge
 *
 * @param bool   $ok    State
 * @param string $yes   Label when true
 * @param string $no    Label when false
 * @return string       HTML
 */
function dolibarrmcpserver_badge($ok, $yes, $no)
{
	return $ok ? '<span class="badge badge-status4 badge-status">'.dol_escape_htmltag($yes).'</span>' : '<span class="badge badge-status8 badge-status">'.dol_escape_htmltag($no).'</span>';
}

llxHeader('', $langs->trans("DolibarrMcpServerSetup"));

$linkback = '<a href="'.DOL_URL_ROOT.'/admin/modules.php?restore_lastsearch_values=1">'.$langs->trans("BackToModuleList").'</a>';
print load_fiche_titre($langs->trans("DolibarrMcpServerSetup"), $linkback, 'title_setup');

print '<div class="opacitymedium" style="margin-bottom: 15px">'.dol_escape_htmltag($langs->trans("DolibarrMcpServerIntro")).'</div>';

// Checks
print '<div class="div-table-responsive-no-min">';
print '<table class="noborder centpercent">';
print '<tr class="liste_titre"><td>'.$langs->trans("DolibarrMcpServerChecks").'</td><td></td></tr>';
print '<tr class="oddeven"><td>'.$langs->trans("DolibarrMcpServerApiModule").'</td><td>'.dolibarrmcpserver_badge($apienabled, $langs->trans("DolibarrMcpServerEnabled"), $langs->trans("DolibarrMcpServerNotEnabled")).'</td></tr>';
print '<tr class="oddeven"><td>'.$langs->trans("DolibarrMcpServerDolibarrUrl").'</td><td><code>'.dol_escape_htmltag($dolibarrurl).'</code></td></tr>';
print '<tr class="oddeven"><td>'.$langs->trans("DolibarrMcpServerBundledServer").'</td><td>'.dolibarrmcpserver_badge($serverpresent, $langs->trans("DolibarrMcpServerPresent"), $langs->trans("DolibarrMcpServerMissing")).' <code>'.dol_escape_htmltag($serverdir).'</code></td></tr>';
print '<tr class="oddeven"><td>'.$langs->trans("DolibarrMcpServerUserApiKey").'</td><td>'.dolibarrmcpserver_badge($haskey, $langs->trans("DolibarrMcpServerPresent"), $langs->trans("DolibarrMcpServerMissing")).'</td></tr>';
print '</table>';
print '</div>';

// Installation
$config = '{
  "mcpServers": {
    "dolibarr": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/opt/dolibarr-mcp-server/dist/index.js", "stdio"],
      "env": {
        "DOLIBARR_URL": "'.$dolibarrurl.'",
        "DOLIBARR_API_KEY": "your-dolibarr-api-key"
      }
    }
  }
}';

print '<br>';
print '<table class="noborder centpercent">';
print '<tr class="liste_titre"><td>'.$langs->trans("DolibarrMcpServerInstall").'</td></tr>';
print '<tr class="oddeven"><td>';
print '<ol>';
print '<li>'.dol_escape_htmltag($langs->trans("DolibarrMcpServerInstallStep1")).'</li>';
print '<li>'.dol_escape_htmltag($langs->trans("DolibarrMcpServerInstallStep2"));
print '<pre>cp -R '.dol_escape_htmltag($serverdir).' /opt/dolibarr-mcp-server'."\n".'cd /opt/dolibarr-mcp-server'."\n".'npm ci --omit=dev</pre></li>';
print '<li>'.dol_escape_htmltag($langs->trans("DolibarrMcpServerInstallStep3")).'</li>';
print '<li>'.dol_escape_htmltag($langs->trans("DolibarrMcpServerInstallStep4"));
print '<pre>'.dol_escape_htmltag($config).'</pre></li>';
print '</ol>';
print '<p>'.dol_escape_htmltag($langs->trans("DolibarrMcpServerTeam")).'</p>';
print '<p><a href="'.$docurl.'" target="_blank" rel="noopener noreferrer">'.$langs->trans("DolibarrMcpServerDocs").'</a></p>';
print '</td></tr>';
print '</table>';

llxFooter();
$db->close();
