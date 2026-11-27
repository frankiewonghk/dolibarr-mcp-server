<?php
/* Copyright (C) 2026 LH Wong
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * \file    core/modules/modDolibarrMcpServer.class.php
 * \ingroup dolibarrmcpserver
 * \brief   Module descriptor for Dolibarr MCP Server
 */

include_once DOL_DOCUMENT_ROOT.'/core/modules/DolibarrModules.class.php';

/**
 * Description and activation class for module DolibarrMcpServer
 */
class modDolibarrMcpServer extends DolibarrModules
{
	/**
	 * Constructor
	 *
	 * @param DoliDB $db Database handler
	 */
	public function __construct($db)
	{
		global $langs;

		$this->db = $db;

		$this->numero = 207510;
		$this->rights_class = 'dolibarrmcpserver';
		$this->family = 'interface';
		$this->module_position = '90';
		$this->name = preg_replace('/^mod/i', '', get_class($this));
		$this->description = "Connect AI assistants such as Claude to Dolibarr through the Model Context Protocol (MCP)";
		$this->descriptionlong = "Bundles the Dolibarr MCP Server, a Node.js server that lets AI assistants work with Dolibarr data through the REST API, and adds a setup page with installation instructions for this instance.";
		$this->editor_name = 'LH Wong';
		$this->editor_url = 'https://github.com/frankiewonghk/dolibarr-mcp-server';
		$this->version = '1.0.1';
		$this->const_name = 'MAIN_MODULE_'.strtoupper($this->name);
		$this->picto = 'technic';

		$this->module_parts = array();
		$this->dirs = array();
		$this->config_page_url = array("setup.php@dolibarrmcpserver");

		$this->hidden = false;
		// The MCP server talks to Dolibarr through the REST API
		$this->depends = array('modApi');
		$this->requiredby = array();
		$this->conflictwith = array();
		$this->langfiles = array("dolibarrmcpserver@dolibarrmcpserver");
		$this->phpmin = array(7, 4);
		$this->need_dolibarr_version = array(20, 0);

		$this->const = array();
		$this->tabs = array();
		$this->dictionaries = array();
		$this->boxes = array();
		$this->cronjobs = array();
		$this->rights = array();
		$this->menu = array();
	}

	/**
	 * Function called when module is enabled.
	 *
	 * @param string $options Options when enabling module ('', 'noboxes')
	 * @return int 1 if OK, 0 if KO
	 */
	public function init($options = '')
	{
		$this->remove($options);
		$sql = array();
		return $this->_init($sql, $options);
	}

	/**
	 * Function called when module is disabled.
	 *
	 * @param string $options Options when disabling module ('', 'noboxes')
	 * @return int 1 if OK, 0 if KO
	 */
	public function remove($options = '')
	{
		$sql = array();
		return $this->_remove($sql, $options);
	}
}
