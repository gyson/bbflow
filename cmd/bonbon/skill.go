package main

import (
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"os"
)

// The skill text teaches an agent how to read the archive. The binary embeds it, so the
// text always matches the installed commands and schema. A test compares its tables
// with the migrated schema and runs its examples.
//
//go:embed skill.md
var skillText string

func skill(args []string) error {
	flags := flag.NewFlagSet("skill", flag.ContinueOnError)
	flags.Usage = func() {
		fmt.Println("Usage: bonbon skill\n\nPrint a Markdown guide for agents. It explains how to read BonBon sessions and\nrecorded history with bonbon query. The command does not contact a server.")
	}
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("skill takes no arguments")
	}
	_, err := fmt.Fprint(os.Stdout, skillText)
	return err
}
