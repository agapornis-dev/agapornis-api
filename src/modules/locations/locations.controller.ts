import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../security/jwt-auth.guard";
import { Roles } from "../security/roles.decorator";
import { RolesGuard } from "../security/roles.guard";
import { LocationsService } from "./locations.service";
import { CreateLocationDto, UpdateLocationDto } from './dto/location.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("locations")
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}
  @Get() 
  @Roles("admin") 
  list() {
    return this.locations.list();
  }
  @Post() 
  @Roles("admin") 
  create(@Body() body: CreateLocationDto) {
    return this.run(() => this.locations.create(body));
  }
  @Patch(":id") 
  @Roles("admin") update(
    @Param("id") id: string,
    @Body() body: UpdateLocationDto,
  ) {
    return this.run(() => this.locations.update(id, body));
  }
  @Delete(":id") 
  @Roles("admin")
  remove(@Param("id") id: string) {
    return this.run(() => this.locations.remove(id));
  }
  private async run<T>(task: () => Promise<T>) {
    try {
      return await task();
    } catch (error: any) {
      throw new HttpException(
        error?.message || "location request failed",
        error?.message === "location not found"
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST,
      );
    }
  }
}
