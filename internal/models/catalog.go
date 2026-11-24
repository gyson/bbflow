package models

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Model is one choice of a model list. Efforts lists its thinking efforts. Default is
// the effort that the CLI uses when bbflow adds no effort option. It is empty when the
// list does not tell it.
type Model struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Efforts []string `json:"efforts"`
	Default string   `json:"default,omitempty"`
}

// Catalog is the model list of a tool type. Source is the command that printed it, or
// empty for a built-in list. Efforts lists the efforts that the CLI accepts with any
// model, also with the CLI default model.
type Catalog struct {
	Type    string   `json:"type"`
	Source  string   `json:"source"`
	Models  []Model  `json:"models"`
	Efforts []string `json:"efforts"`
}

// ListCommand returns the command that prints the model list of a type. program is the
// CLI path of the built-in tool of the type, or the plain CLI name. Claude Code has no
// such command, and a Custom tool has no list.
func ListCommand(kind, program string) string {
	switch kind {
	case Codex:
		return program + " debug models"
	case Agy:
		return program + " models"
	case CodePuppy:
		return program + " --setup model list"
	}
	return ""
}

// The thinking efforts of Codex and Claude Code. The Codex model list gives the efforts
// of each model. These are the efforts for the CLI default model.
var (
	codexEfforts  = []string{"low", "medium", "high", "xhigh", "max"}
	claudeEfforts = []string{"low", "medium", "high", "xhigh", "max"}
)

// Builtin returns the list of a type without a list command. Claude Code accepts an
// alias for the latest model of a family, or a full model name.
func Builtin(kind string) Catalog {
	if kind != Claude {
		return Catalog{Type: kind, Models: []Model{}, Efforts: []string{}}
	}
	models := []Model{
		{ID: "fable", Name: "fable (latest Fable)"},
		{ID: "opus", Name: "opus (latest Opus)"},
		{ID: "sonnet", Name: "sonnet (latest Sonnet)"},
		{ID: "haiku", Name: "haiku (latest Haiku)"},
		{ID: "claude-fable-5-2", Name: "claude-fable-5-2"},
		{ID: "claude-opus-5-5", Name: "claude-opus-5-5"},
		{ID: "claude-sonnet-5-5", Name: "claude-sonnet-5-5"},
		{ID: "claude-haiku-5-5", Name: "claude-haiku-5-5"},
	}
	for i := range models {
		models[i].Efforts = claudeEfforts
	}
	return Catalog{Type: Claude, Models: models, Efforts: claudeEfforts}
}

// Parse reads the output of the list command of a type. Source names the command with
// the plain CLI name. A caller that ran another program sets it.
func Parse(kind string, output []byte) (Catalog, error) {
	catalog := Catalog{Type: kind, Source: ListCommand(kind, kind), Models: []Model{}, Efforts: []string{}}
	var err error
	switch kind {
	case Codex:
		catalog.Models, err = parseCodex(output)
		catalog.Efforts = codexEfforts
	case Agy:
		catalog.Models = parseAgy(output)
	case CodePuppy:
		catalog.Models = parseCodePuppy(output)
	default:
		return catalog, fmt.Errorf("%s has no model list command", Name(kind))
	}
	if err == nil && len(catalog.Models) == 0 {
		err = errors.New("the list has no models")
	}
	return catalog, err
}

// parseCodex reads the JSON catalog of `codex debug models`. It keeps the models that
// Codex shows in its own model menu.
func parseCodex(output []byte) ([]Model, error) {
	var data struct {
		Models []struct {
			Slug       string `json:"slug"`
			Name       string `json:"display_name"`
			Visibility string `json:"visibility"`
			Default    string `json:"default_reasoning_level"`
			Levels     []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	if err := json.Unmarshal(output, &data); err != nil {
		return nil, fmt.Errorf("read the Codex model list: %w", err)
	}
	models := []Model{}
	for _, m := range data.Models {
		if m.Visibility != "list" || !modelPattern.MatchString(m.Slug) {
			continue
		}
		model := Model{ID: m.Slug, Name: m.Slug, Efforts: []string{}}
		for _, level := range m.Levels {
			if effortPattern.MatchString(level.Effort) {
				model.Efforts = append(model.Efforts, level.Effort)
			}
		}
		if slices.Contains(model.Efforts, m.Default) {
			model.Default = m.Default
		}
		models = append(models, model)
	}
	return models, nil
}

// agyEfforts are the efforts that Antigravity puts at the end of a model ID.
var agyEfforts = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

// parseAgy reads the lines of `agy models`. Each line has a model ID, a tab, and a
// display name. IDs such as gemini-4-neon-high and names such as "Gemini 4 Neon (High)"
// join to one model with its efforts. Other lines, such as a progress message, have no
// tab.
func parseAgy(output []byte) []Model {
	models := []Model{}
	index := map[string]int{}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		id, name, found := strings.Cut(scanner.Text(), "\t")
		id, name = strings.TrimSpace(id), strings.TrimSpace(name)
		if !found || !modelPattern.MatchString(id) {
			continue
		}
		family, familyName, effort := id, name, ""
		for _, e := range agyEfforts {
			if base, ok := strings.CutSuffix(id, "-"+e); ok {
				if label, ok := strings.CutSuffix(name, " ("+effortName(e)+")"); ok {
					family, familyName, effort = base, label, e
				}
				break
			}
		}
		i, seen := index[family]
		if !seen {
			i = len(models)
			index[family] = i
			models = append(models, Model{ID: family, Name: familyName, Efforts: []string{}})
		}
		if effort != "" && !slices.Contains(models[i].Efforts, effort) {
			models[i].Efforts = append(models[i].Efforts, effort)
		}
	}
	for i := range models {
		slices.SortFunc(models[i].Efforts, func(a, b string) int {
			return slices.Index(agyEfforts, a) - slices.Index(agyEfforts, b)
		})
	}
	return models
}

// effortName returns the label of an effort in an Antigravity model name.
func effortName(effort string) string {
	if effort == "xhigh" {
		return "XHigh"
	}
	return strings.ToUpper(effort[:1]) + effort[1:]
}

// parseCodePuppy reads the lines of `code-puppy --setup model list`. Each line has the
// Code Puppy name of a model, its provider in brackets, and the model of the provider.
// A star marks the default model of Code Puppy.
func parseCodePuppy(output []byte) []Model {
	models := []Model{}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(scanner.Text()), "*"))
		if len(fields) < 2 || !strings.HasPrefix(fields[1], "[") || !modelPattern.MatchString(fields[0]) {
			continue
		}
		name := fields[0]
		if len(fields) > 2 && fields[len(fields)-1] != fields[0] {
			name += " → " + fields[len(fields)-1]
		}
		models = append(models, Model{ID: fields[0], Name: name, Efforts: []string{}})
	}
	return models
}
