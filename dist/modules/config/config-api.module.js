"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigApiModule = void 0;
const common_1 = require("@nestjs/common");
const config_api_controller_1 = require("./config-api.controller");
const public_module_1 = require("../public/public.module");
let ConfigApiModule = class ConfigApiModule {
};
exports.ConfigApiModule = ConfigApiModule;
exports.ConfigApiModule = ConfigApiModule = __decorate([
    (0, common_1.Module)({
        imports: [public_module_1.PublicModule],
        controllers: [config_api_controller_1.ConfigApiController, config_api_controller_1.AppApiController],
    })
], ConfigApiModule);
