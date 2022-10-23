//
// Code generated by go-jet DO NOT EDIT.
//
// WARNING: Changes to this file may cause incorrect behavior
// and will be lost if the code is regenerated
//

package table

import (
	"github.com/go-jet/jet/v2/postgres"
)

var License = newLicenseTable("package", "license", "")

type licenseTable struct {
	postgres.Table

	//Columns
	ID   postgres.ColumnString
	Name postgres.ColumnString

	AllColumns     postgres.ColumnList
	MutableColumns postgres.ColumnList
}

type LicenseTable struct {
	licenseTable

	EXCLUDED licenseTable
}

// AS creates new LicenseTable with assigned alias
func (a LicenseTable) AS(alias string) *LicenseTable {
	return newLicenseTable(a.SchemaName(), a.TableName(), alias)
}

// Schema creates new LicenseTable with assigned schema name
func (a LicenseTable) FromSchema(schemaName string) *LicenseTable {
	return newLicenseTable(schemaName, a.TableName(), a.Alias())
}

// WithPrefix creates new LicenseTable with assigned table prefix
func (a LicenseTable) WithPrefix(prefix string) *LicenseTable {
	return newLicenseTable(a.SchemaName(), prefix+a.TableName(), a.TableName())
}

// WithSuffix creates new LicenseTable with assigned table suffix
func (a LicenseTable) WithSuffix(suffix string) *LicenseTable {
	return newLicenseTable(a.SchemaName(), a.TableName()+suffix, a.TableName())
}

func newLicenseTable(schemaName, tableName, alias string) *LicenseTable {
	return &LicenseTable{
		licenseTable: newLicenseTableImpl(schemaName, tableName, alias),
		EXCLUDED:     newLicenseTableImpl("", "excluded", ""),
	}
}

func newLicenseTableImpl(schemaName, tableName, alias string) licenseTable {
	var (
		IDColumn       = postgres.StringColumn("id")
		NameColumn     = postgres.StringColumn("name")
		allColumns     = postgres.ColumnList{IDColumn, NameColumn}
		mutableColumns = postgres.ColumnList{NameColumn}
	)

	return licenseTable{
		Table: postgres.NewTable(schemaName, tableName, alias, allColumns...),

		//Columns
		ID:   IDColumn,
		Name: NameColumn,

		AllColumns:     allColumns,
		MutableColumns: mutableColumns,
	}
}
